import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyEdits, type Op } from './applyEdits.ts';

// Read results back with pdf.js, the same engine the editor uses.
async function read(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const titles = (items: { title: string; items: unknown[] }[]): unknown[] =>
    items.map(i => (i.items.length ? [i.title, titles(i.items as never)] : i.title));
  const outline = await doc.getOutline();
  const pageOf = async (i: { dest: unknown }) => doc.getPageIndex((i.dest as [never])[0]);
  const result = { outline: outline ? titles(outline) : null, pages: outline ? await Promise.all(outline.map(pageOf)) : [] };
  await task.destroy();
  return result;
}

async function pages(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([600, 800]);
  return doc.save();
}

test('bookmarks: added in reading order, renamed, deleted', async () => {
  const ops: Op[] = [
    { kind: 'addBookmark', page: 2, y: 700, title: 'Third page' },
    { kind: 'addBookmark', page: 0, y: 500, title: 'First page, middle' },
    { kind: 'addBookmark', page: 0, y: 790, title: 'First page, top' },
  ];
  let r = await read(await applyEdits(await pages(3), ops));
  assert.deepEqual(r.outline, ['First page, top', 'First page, middle', 'Third page']);
  assert.deepEqual(r.pages, [0, 0, 2]);

  r = await read(await applyEdits(await pages(3), [...ops,
    { kind: 'renameBookmark', path: [2], title: 'Àllegato – finale' },
    { kind: 'deleteBookmark', path: [0] },
  ]));
  assert.deepEqual(r.outline, ['First page, middle', 'Àllegato – finale']);

  r = await read(await applyEdits(await pages(3), [...ops, { kind: 'deleteBookmark', path: [0] }, { kind: 'deleteBookmark', path: [0] }, { kind: 'deleteBookmark', path: [0] }]));
  assert.ok(!r.outline?.length);
});

test('bookmark ops reject a path that does not exist', async () => {
  await assert.rejects(applyEdits(await pages(1), [{ kind: 'deleteBookmark', path: [0] }]), /Bookmark not found/);
});
