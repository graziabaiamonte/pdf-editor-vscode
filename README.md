# PDF Editor (local)

Personal VS Code extension: open `.pdf` files in VS Code to delete pages, add text, highlights, underlines, sticky notes and images.

- Cmd+S saves (overwrites the PDF), Cmd+Z / Cmd+Shift+Z undo and redo, "Revert File" discards your edits.
- Highlights, underlines and notes are saved as real PDF annotations. Text and images are drawn into the page.
- Delete: with Select, click a highlight, underline or added text and press "Delete …"; a note has a ✕ next to it (or focus it and press Delete). Highlights, underlines and notes can be deleted at any time, even ones already in the file; text only until you close the PDF, because once saved it is part of the page.
- Left sidebar (Index button): bookmarks, click to jump. + adds a bookmark where you are; ✎ or F2 renames one; ✕ or Delete removes it. Saved as real PDF bookmarks.
- Inserted images: drag to move, drag the corner to resize (arrow keys / Shift+arrows too).
- Highlight and underline colours: edit `src/colors.ts`, then rebuild.
- Merge: select 2+ PDFs in the Explorer → right-click → Merge PDFs (merged in file-name order).

## Develop
```sh
npm install
npm test          # applyEdits tests
npm run build     # or: npm run watch
```
Press F5 in VS Code to open an Extension Development Host with the extension loaded.

## Install
```sh
npm run package
code --install-extension pdf-editor-0.0.1.vsix
```
(or Extensions view → … → Install from VSIX…)
