import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { applyEdits, Op, placed } from './applyEdits.ts';

class PdfDocument implements vscode.CustomDocument {
  ops: Op[] = [];
  constructor(readonly uri: vscode.Uri, public original: Uint8Array) {}
  render() { return applyEdits(this.original, this.ops); }
  // Images are left out of the preview: the webview draws them as movable, resizable elements.
  preview(annotOps: Record<string, number>) { return applyEdits(this.original, this.ops, { images: false, annotOps }); }
  dispose() {}
}

export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = 'pdfEditor.editor';
  private readonly webviews = new Map<PdfDocument, vscode.Webview>();
  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, ctx: vscode.CustomDocumentOpenContext) {
    // A backup holds the already-edited bytes, so it becomes the new original with no pending ops.
    const source = ctx.backupId ? vscode.Uri.parse(ctx.backupId) : uri;
    return new PdfDocument(uri, await vscode.workspace.fs.readFile(source));
  }

  async resolveCustomEditor(doc: PdfDocument, panel: vscode.WebviewPanel) {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = this.html(webview, dist);
    this.webviews.set(doc, webview);
    panel.onDidDispose(() => this.webviews.delete(doc));

    webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') return this.refresh(doc);
      if (msg.type === 'edit') return this.edit(doc, msg.op as Op);
      if (msg.type === 'moveImage') return this.moveImage(doc, msg.opIndex, msg.rect);
      if (msg.type === 'deletePage') {
        const ok = await vscode.window.showWarningMessage(`Delete page ${msg.page + 1}?`, { modal: true, detail: 'You can undo this with Cmd+Z until you close the file.' }, 'Delete');
        if (ok) return this.edit(doc, { kind: 'deletePage', page: msg.page });
      }
      if (msg.type === 'error') vscode.window.showErrorMessage(`PDF Editor: ${msg.message}`);
    });
  }

  private async edit(doc: PdfDocument, op: Op) {
    doc.ops.push(op);
    if (!(await this.refresh(doc))) return void doc.ops.pop(); // invalid op: drop it, nothing to undo
    this.changed.fire({
      document: doc,
      label: op.kind,
      undo: async () => { doc.ops.pop(); await this.refresh(doc); },
      redo: async () => { doc.ops.push(op); await this.refresh(doc); },
    });
  }

  private async moveImage(doc: PdfDocument, opIndex: number, rect: { x: number; y: number; w: number; h: number }) {
    const before = doc.ops[opIndex];
    if (before?.kind !== 'image' || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return;
    const after: Op = { ...before, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    doc.ops[opIndex] = after;
    await this.refresh(doc);
    this.changed.fire({
      document: doc,
      label: 'move image',
      undo: async () => { doc.ops[opIndex] = before; await this.refresh(doc); },
      redo: async () => { doc.ops[opIndex] = after; await this.refresh(doc); },
    });
  }

  private async refresh(doc: PdfDocument) {
    try {
      const annotOps: Record<string, number> = {};
      const bytes = await doc.preview(annotOps);
      // Base64: VS Code's webview messaging doesn't reliably deliver a Uint8Array as a typed array.
      this.webviews.get(doc)?.postMessage({ type: 'load', base64: Buffer.from(bytes).toString('base64'), images: placed(doc.ops, 'image'), texts: placed(doc.ops, 'text'), annotOps });
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`PDF Editor: ${(e as Error).message}`);
      return false;
    }
  }

  async saveCustomDocument(doc: PdfDocument) {
    await this.saveCustomDocumentAs(doc, doc.uri);
  }

  async saveCustomDocumentAs(doc: PdfDocument, target: vscode.Uri) {
    await vscode.workspace.fs.writeFile(target, await doc.render());
  }

  async revertCustomDocument(doc: PdfDocument) {
    doc.original = await vscode.workspace.fs.readFile(doc.uri);
    doc.ops = [];
    await this.refresh(doc);
  }

  async backupCustomDocument(doc: PdfDocument, ctx: vscode.CustomDocumentBackupContext) {
    await vscode.workspace.fs.writeFile(ctx.destination, await doc.render());
    return { id: ctx.destination.toString(), delete: () => vscode.workspace.fs.delete(ctx.destination).then(undefined, () => {}) };
  }

  private html(webview: vscode.Webview, dist: vscode.Uri) {
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f)).toString();
    const nonce = randomBytes(16).toString('base64');
    const src = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; font-src ${src} data:;
  style-src ${src} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('pdf_viewer.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="PDF tools">
  <button id="toggleIndex" aria-pressed="true" title="Show or hide the index">Index</button>
  <span class="sep"></span>
  <button data-tool="select" aria-pressed="true" title="Select / scroll">Select</button>
  <button data-tool="highlight" title="Select text to highlight it">Highlight</button>
  <span class="swatches" data-for="highlight" role="group" aria-label="Highlight colour"></span>
  <button data-tool="underline" title="Select text to underline it">Underline</button>
  <span class="swatches" data-for="underline" role="group" aria-label="Underline colour"></span>
  <button data-tool="text" title="Click on a page to add text">Text</button>
  <button data-tool="note" title="Click on a page to add a sticky note">Note</button>
  <button data-tool="image" title="Choose a PNG/JPG, then click on a page to place it. Drag it to move, drag the corner to resize">Image</button>
  <span class="sep"></span>
  <button id="twoPages" aria-pressed="false" title="Show two pages side by side">Two pages</button>
  <button id="zoomOut" title="Zoom out" aria-label="Zoom out">−</button>
  <span id="zoomLabel">100%</span>
  <button id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
  <span id="status" aria-live="polite"></span>
</div>
<input id="imageInput" type="file" accept="image/png,image/jpeg" hidden>
<div id="main">
  <nav id="sidebar" aria-label="Index"></nav>
  <div id="pages"></div>
</div>
<script nonce="${nonce}">window.PDF_ASSETS = ${JSON.stringify({
      worker: uri('pdf.worker.min.mjs'), cMapUrl: uri('cmaps/'), standardFontDataUrl: uri('standard_fonts/'),
      iccUrl: uri('iccs/'), wasmUrl: uri('wasm/'),
    })};</script>
<script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}
