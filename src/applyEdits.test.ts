import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyEdits, placed, type Op } from './applyEdits.ts';

// 1x1 red PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function threePages() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([600, 800]).drawText(`Page ${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

test('applies every op kind and produces a loadable PDF', async () => {
  const out = await applyEdits(await threePages(), [
    { kind: 'deletePage', page: 0 },
    { kind: 'text', page: 0, x: 50, y: 600, text: 'Hello\nworld', size: 12 },
    { kind: 'highlight', page: 0, quads: [[50, 700, 120, 712], [50, 680, 90, 692]], color: [0.45, 0.75, 1] },
    { kind: 'underline', page: 1, quads: [[50, 700, 120, 712]], color: [0, 0, 0] },
    { kind: 'note', page: 1, x: 300, y: 400, contents: 'Nota: è importante' },
    { kind: 'image', page: 1, x: 100, y: 100, w: 50, h: 50, dataUrl: PNG },
  ]);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);

  const subtypes = (i: number) => (doc.getPage(i).node.Annots()?.asArray() ?? [])
    .map(ref => (doc.context.lookup(ref, PDFDict).get(PDFName.of('Subtype')) as PDFName).decodeText());
  assert.deepEqual(subtypes(0), ['Highlight']);
  assert.deepEqual(subtypes(1), ['Underline', 'Text']);

  const hl = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0), PDFDict);
  assert.equal(hl.lookup(PDFName.of('QuadPoints'), PDFArray).size(), 16);
  assert.deepEqual(hl.lookup(PDFName.of('C'), PDFArray).asArray().map(n => Number(n.toString())), [0.45, 0.75, 1]);
  assert.deepEqual(hl.lookup(PDFName.of('Rect'), PDFArray).asArray().map(n => Number(n.toString())), [50, 680, 120, 712]);
});

test('no ops returns the original bytes untouched', async () => {
  const bytes = await threePages();
  assert.equal(await applyEdits(bytes, []), bytes);
});

test('rejects deleting the only page and out-of-range pages', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const one = await doc.save();
  await assert.rejects(applyEdits(one, [{ kind: 'deletePage', page: 0 }]), /only page/);
  await assert.rejects(applyEdits(one, [{ kind: 'note', page: 5, x: 0, y: 0, contents: '' }]), /does not exist/);
});

test('placed follows later page deletions', () => {
  const img = (page: number): Op => ({ kind: 'image', page, x: 0, y: 0, w: 10, h: 10, dataUrl: PNG });
  const ops: Op[] = [img(0), img(2), img(3), { kind: 'deletePage', page: 2 }, { kind: 'deletePage', page: 0 }, img(0)];
  assert.deepEqual(placed(ops, 'image').map(i => [i.opIndex, i.page]), [[2, 1], [5, 0]]);
});

test('deletes annotations from the file by ref and added ones by op index', async () => {
  const original = await applyEdits(await threePages(), [{ kind: 'underline', page: 0, quads: [[50, 700, 120, 712]], color: [0, 0, 0] }]);
  const ops: Op[] = [
    { kind: 'image', page: 0, x: 0, y: 0, w: 10, h: 10, dataUrl: PNG },
    { kind: 'highlight', page: 0, quads: [[50, 700, 120, 712]], color: [1, 1, 0] },
    { kind: 'note', page: 0, x: 300, y: 400, contents: 'x' },
    { kind: 'text', page: 0, x: 50, y: 600, text: 'gone', size: 12 },
    { kind: 'deleteOp', opIndex: 1 },
    { kind: 'deleteOp', opIndex: 3 },
  ];
  const subtypes = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes);
    return doc.getPage(0).node.Annots()!.asArray().map(r => doc.context.lookup(r, PDFDict).get(PDFName.of('Subtype'))!.toString());
  };
  const annotOps: Record<string, number> = {};
  await applyEdits(original, ops, { images: false, annotOps });
  assert.deepEqual(Object.values(annotOps), [2]);
  const underline = (await PDFDocument.load(original)).getPage(0).node.Annots()!.get(0) as PDFRef;
  ops.push({ kind: 'deleteAnnot', page: 0, ref: `${underline.objectNumber}R` });
  assert.deepEqual(await subtypes(await applyEdits(original, ops)), ['/Text']);
  assert.deepEqual(placed(ops, 'text'), []);
  await assert.rejects(applyEdits(original, [{ kind: 'deleteAnnot', page: 0, ref: '9999R' }]), /not found/);
  await assert.rejects(applyEdits(original, [{ kind: 'deleteOp', opIndex: 0 }]), /Nothing to delete/);
});

test('annotOps keys are the ids pdf.js gives the annotations', async () => {
  const annotOps: Record<string, number> = {};
  const bytes = await applyEdits(await threePages(), [
    { kind: 'note', page: 0, x: 10, y: 100, contents: 'a' },
    { kind: 'highlight', page: 0, quads: [[10, 10, 50, 20]], color: [1, 1, 0] },
  ], { annotOps });
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const ids = (await (await (await task.promise).getPage(1)).getAnnotations()).map(a => a.id);
  await task.destroy();
  assert.deepEqual(ids.map(id => annotOps[id]), [0, 1]);
});
