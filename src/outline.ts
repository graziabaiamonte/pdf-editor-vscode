import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

// Bookmarks (the PDF outline).
// A bookmark is addressed by its path in the outline tree: [2, 0] = first child of the third top-level bookmark.

const N = PDFName.of;
type Node = { ref: PDFRef; dict: PDFDict };

function children(doc: PDFDocument, parent: PDFDict): Node[] {
  const out: Node[] = [];
  let ref = parent.get(N('First'));
  while (ref instanceof PDFRef && out.length < 100_000) {
    const dict = doc.context.lookup(ref, PDFDict);
    out.push({ ref, dict });
    ref = dict.get(N('Next'));
  }
  return out;
}

// Re-links a parent's children as a doubly linked list in the given order.
function relink(parentRef: PDFRef, parent: PDFDict, kids: Node[]) {
  for (const key of ['First', 'Last']) parent.delete(N(key));
  kids.forEach(({ dict }, i) => {
    dict.set(N('Parent'), parentRef);
    for (const key of ['Prev', 'Next']) dict.delete(N(key));
    if (i > 0) dict.set(N('Prev'), kids[i - 1].ref);
    if (i < kids.length - 1) dict.set(N('Next'), kids[i + 1].ref);
  });
  if (kids.length) {
    parent.set(N('First'), kids[0].ref);
    parent.set(N('Last'), kids[kids.length - 1].ref);
  }
}

// /Count = number of visible descendants; negative when the item is collapsed.
function fixCounts(doc: PDFDocument, node: PDFDict): number {
  let visible = 0;
  for (const kid of children(doc, node)) {
    const sub = fixCounts(doc, kid.dict);
    const count = kid.dict.get(N('Count'));
    const open = !(count instanceof PDFNumber && count.asNumber() < 0);
    if (sub) kid.dict.set(N('Count'), PDFNumber.of(open ? sub : -sub));
    else kid.dict.delete(N('Count'));
    visible += 1 + (open ? sub : 0);
  }
  return visible;
}

function outlineRoot(doc: PDFDocument, create: boolean): Node | undefined {
  let ref = doc.catalog.get(N('Outlines'));
  if (!(ref instanceof PDFRef)) {
    if (!create) return undefined;
    ref = doc.context.register(doc.context.obj({ Type: 'Outlines' }));
    doc.catalog.set(N('Outlines'), ref);
  }
  return { ref: ref as PDFRef, dict: doc.context.lookup(ref, PDFDict) };
}

function nodeAt(doc: PDFDocument, path: number[]): { parent: Node; kids: Node[]; index: number } {
  let parent = outlineRoot(doc, false);
  for (let depth = 0; parent; depth++) {
    const kids = children(doc, parent.dict);
    const index = path[depth];
    if (!kids[index]) break;
    if (depth === path.length - 1) return { parent, kids, index };
    parent = kids[index];
  }
  throw new Error('Bookmark not found');
}

// Page index and top y of a bookmark with a direct destination, used to keep new bookmarks in reading order.
function position(doc: PDFDocument, dict: PDFDict): [number, number] | undefined {
  const action = dict.lookupMaybe(N('A'), PDFDict);
  const dest = dict.lookupMaybe(N('Dest'), PDFArray) ?? action?.lookupMaybe(N('D'), PDFArray);
  const page = doc.getPages().findIndex(p => p.ref === dest?.get(0));
  if (!dest || page < 0) return undefined;
  const y = dest.lookup(N('XYZ') === dest.get(1) ? 3 : 2);
  return [page, y instanceof PDFNumber ? y.asNumber() : Infinity];
}

export function addBookmark(doc: PDFDocument, page: number, y: number, title: string) {
  const root = outlineRoot(doc, true)!;
  const ref = doc.context.register(doc.context.obj({
    Title: PDFHexString.fromText(title),
    Parent: root.ref,
    Dest: [doc.getPage(page).ref, 'XYZ', null, y, null],
  }));
  const kids = children(doc, root.dict);
  // Before the first top-level bookmark that comes later in the document.
  let at = kids.findIndex(k => {
    const p = position(doc, k.dict);
    return p && (p[0] > page || (p[0] === page && p[1] < y));
  });
  if (at < 0) at = kids.length;
  kids.splice(at, 0, { ref, dict: doc.context.lookup(ref, PDFDict) });
  relink(root.ref, root.dict, kids);
  root.dict.set(N('Count'), PDFNumber.of(fixCounts(doc, root.dict)));
}

export function renameBookmark(doc: PDFDocument, path: number[], title: string) {
  const { kids, index } = nodeAt(doc, path);
  kids[index].dict.set(N('Title'), PDFHexString.fromText(title));
}

export function deleteBookmark(doc: PDFDocument, path: number[]) {
  const { parent, kids, index } = nodeAt(doc, path);
  kids.splice(index, 1);
  relink(parent.ref, parent.dict, kids);
  const root = outlineRoot(doc, false)!;
  root.dict.set(N('Count'), PDFNumber.of(fixCounts(doc, root.dict)));
}
