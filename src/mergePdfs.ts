import { PDFDocument } from 'pdf-lib';

// Appends every page of each PDF, in the given order, into one new PDF.
export async function mergePdfs(files: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const f of files) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(f.bytes);
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save();
}
