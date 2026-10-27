import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs } from './mergePdfs.ts';

async function pdf(sizes: [number, number][]) {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
}

test('merges all pages in order', async () => {
  const out = await PDFDocument.load(await mergePdfs([
    { name: 'a.pdf', bytes: await pdf([[100, 100], [200, 200]]) },
    { name: 'b.pdf', bytes: await pdf([[300, 300]]) },
  ]));
  assert.deepEqual(out.getPages().map(p => p.getWidth()), [100, 200, 300]);
});

test('names the file that cannot be read', async () => {
  await assert.rejects(mergePdfs([{ name: 'broken.pdf', bytes: new Uint8Array([1, 2, 3]) }]), /broken\.pdf/);
});
