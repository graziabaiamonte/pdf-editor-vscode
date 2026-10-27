import { PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFRef, StandardFonts, rgb } from 'pdf-lib';
import { addBookmark, deleteBookmark, renameBookmark } from './outline.ts';

// Coordinates are PDF user-space points (origin bottom-left). `page` is the page index at the time the op was made.
export type Op =
  | { kind: 'deletePage'; page: number }
  | { kind: 'text'; page: number; x: number; y: number; text: string; size: number }
  | { kind: 'highlight' | 'underline'; page: number; quads: number[][]; color: number[] } // quad: [x1, y1, x2, y2]; color: rgb 0–1
  | { kind: 'note'; page: number; x: number; y: number; contents: string }
  | { kind: 'image'; page: number; x: number; y: number; w: number; h: number; dataUrl: string }
  | { kind: 'addBookmark'; page: number; y: number; title: string }
  | { kind: 'renameBookmark'; path: number[]; title: string } // path: see outline.ts
  | { kind: 'deleteBookmark'; path: number[] }
  | { kind: 'deleteAnnot'; page: number; ref: string } // an annotation that was already in the file; ref: pdf.js id, e.g. "12R"
  | { kind: 'deleteOp'; opIndex: number }; // drops an earlier text, highlight, underline or note op

const DELETABLE: Op['kind'][] = ['text', 'highlight', 'underline', 'note'];

const NOTE_COLOR = [1, 0.85, 0];

// images: false leaves image ops out (the preview; op indexes stay the same).
// annotOps: filled with pdf.js annotation id → index of the op that added it, so the editor can delete it by op.
export async function applyEdits(bytes: Uint8Array, ops: Op[], { images = true, annotOps = {} as Record<string, number> } = {}): Promise<Uint8Array> {
  if (ops.length === 0) return bytes;
  const doc = await PDFDocument.load(bytes);
  let font: PDFFont | undefined;
  const deleted = deletedOps(ops);
  for (const [i, op] of ops.entries()) {
    if (op.kind === 'deleteOp') {
      if (!DELETABLE.includes(ops[op.opIndex]?.kind)) throw new Error('Nothing to delete');
      continue;
    }
    if (deleted.has(i) || (op.kind === 'image' && !images)) continue;
    const addAnnot = (dict: Record<string, unknown>) => {
      const ref = doc.context.register(doc.context.obj({ Type: 'Annot', F: 4, M: PDFHexString.fromText(pdfDate()), ...dict } as never));
      page.node.addAnnot(ref);
      annotOps[pdfjsId(ref)] = i;
    };
    if ('path' in op) {
      if (op.kind === 'renameBookmark') renameBookmark(doc, op.path, op.title);
      else deleteBookmark(doc, op.path);
      continue;
    }
    if (op.page < 0 || op.page >= doc.getPageCount()) throw new Error(`Page ${op.page + 1} does not exist`);
    const page = doc.getPage(op.page);
    switch (op.kind) {
      case 'addBookmark':
        addBookmark(doc, op.page, op.y, op.title);
        break;
      case 'deletePage':
        if (doc.getPageCount() === 1) throw new Error('Cannot delete the only page');
        doc.removePage(op.page);
        // pdf-lib 1.17.1 bug: removePage leaves the page cache stale, so getPage(i) would return the deleted page.
        (doc as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate();
        break;
      case 'text': {
        // shortcut: Helvetica only encodes WinAnsi (Latin) text; embed a TTF via @pdf-lib/fontkit if you need other scripts.
        font ??= await doc.embedFont(StandardFonts.Helvetica);
        op.text.split('\n').forEach((line, i) =>
          page.drawText(line, { x: op.x, y: op.y - i * op.size * 1.2, size: op.size, font: font!, color: rgb(0, 0, 0) }));
        break;
      }
      case 'image': {
        const img = op.dataUrl.startsWith('data:image/png') ? await doc.embedPng(op.dataUrl) : await doc.embedJpg(op.dataUrl);
        page.drawImage(img, { x: op.x, y: op.y, width: op.w, height: op.h });
        break;
      }
      case 'highlight':
      case 'underline': {
        if (op.quads.length === 0) break;
        const xs = op.quads.flatMap(q => [q[0], q[2]]), ys = op.quads.flatMap(q => [q[1], q[3]]);
        // QuadPoints order per rect: upper-left, upper-right, lower-left, lower-right (what Acrobat and pdf.js expect).
        const quadPoints = op.quads.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);
        addAnnot({
          Subtype: op.kind === 'highlight' ? 'Highlight' : 'Underline',
          Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          QuadPoints: quadPoints,
          C: op.color,
        });
        break;
      }
      case 'deleteAnnot': {
        const annots = page.node.Annots();
        const ref = annots?.asArray().find(r => r instanceof PDFRef && pdfjsId(r) === op.ref);
        if (!ref) throw new Error('Annotation not found');
        // Also drop its popup window, if it has one.
        const popup = doc.context.lookup(ref, PDFDict).get(PDFName.of('Popup'));
        for (const r of [ref, popup]) {
          const at = r && annots!.indexOf(r);
          if (at !== undefined) annots!.remove(at);
        }
        break;
      }
      case 'note':
        addAnnot({
          Subtype: 'Text',
          Rect: [op.x, op.y - 20, op.x + 20, op.y],
          Contents: PDFHexString.fromText(op.contents),
          Name: 'Comment',
          C: NOTE_COLOR,
        });
        break;
    }
  }
  return doc.save();
}

const deletedOps = (ops: Op[]) => new Set(ops.flatMap(op => (op.kind === 'deleteOp' ? [op.opIndex] : [])));
const pdfjsId = (ref: PDFRef) => `${ref.objectNumber}R${ref.generationNumber || ''}`;

export type Placed<K extends 'image' | 'text'> = Extract<Op, { kind: K }> & { opIndex: number };

// Images or texts with the page they're on now, after later page deletions (one on a deleted page is dropped).
export function placed<K extends 'image' | 'text'>(ops: Op[], kind: K): Placed<K>[] {
  const deleted = deletedOps(ops);
  return ops.flatMap((op, opIndex) => {
    if (op.kind !== kind || deleted.has(opIndex)) return [];
    let page = (op as { page: number }).page;
    for (const later of ops.slice(opIndex + 1)) {
      if (later.kind !== 'deletePage') continue;
      if (later.page === page) return [];
      if (later.page < page) page--;
    }
    return [{ ...op, page, opIndex } as Placed<K>];
  });
}

function pdfDate(d = new Date()) {
  return 'D:' + d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
}
