import * as vscode from 'vscode';
import { PdfEditorProvider } from './pdfEditorProvider.ts';
import { mergePdfs } from './mergePdfs.ts';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('pdfEditor.merge', merge),
  );
}

// Explorer context menu: (clicked file, all selected files). Merged in file-name order (natural: 2 before 10),
// because VS Code's selection order isn't reliable; rename files (01-, 02-…) to choose the order.
async function merge(clicked: vscode.Uri | undefined, selected: vscode.Uri[] | undefined) {
  const name = (u: vscode.Uri) => u.path.split('/').pop()!;
  const uris = (selected?.length ? selected : clicked ? [clicked] : [])
    .filter(u => /\.(pdf|png)$/i.test(u.path))
    .sort((a, b) => name(a).localeCompare(name(b), undefined, { numeric: true }));
  if (uris.length < 2) return vscode.window.showWarningMessage('Select at least two PDF or PNG files to merge.');

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(uris[0], '..', 'merged.pdf'),
    filters: { PDF: ['pdf'] },
    title: `Merge ${uris.length} files`,
  });
  if (!target) return;

  try {
    const files = await Promise.all(uris.map(async u => ({ name: name(u), bytes: await vscode.workspace.fs.readFile(u) })));
    await vscode.workspace.fs.writeFile(target, await mergePdfs(files));
    await vscode.commands.executeCommand('vscode.openWith', target, PdfEditorProvider.viewType);
  } catch (e) {
    vscode.window.showErrorMessage(`Merge failed: ${(e as Error).message}`);
  }
}
