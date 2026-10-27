import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { Op, Placed } from '../src/applyEdits.ts';
import { HIGHLIGHT_COLORS, UNDERLINE_COLORS } from '../src/colors.ts';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const assets = (window as unknown as { PDF_ASSETS: Record<string, string> }).PDF_ASSETS;

// Webviews can't start a Worker from the resource origin, so load the worker script through a blob URL.
// Passing our own PDFWorker to getDocument keeps it alive when old documents are destroyed.
const workerCode = await (await fetch(assets.worker)).text();
const worker = new pdfjs.PDFWorker({
  // pdf.js's .d.ts types `port` as null; the runtime takes a Worker.
  port: new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })), { type: 'module' }) as never,
});

type Tool = 'select' | 'highlight' | 'underline' | 'text' | 'note' | 'image';
// Something on the page that can be deleted, with its clickable areas in PDF points ([x1, y1, x2, y2]).
type Deletable = { label: string; op: Op };
type PageInfo = { index: number; viewport: PageViewport; marks: (Deletable & { boxes: number[][] })[] };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesEl = $('pages');
const sidebar = $('sidebar');
const imageInput = $<HTMLInputElement>('imageInput');
const pageInfo = new WeakMap<HTMLElement, PageInfo>();

let tool: Tool = 'select';
let zoom = 1;
let pdf: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let renderGen = 0;
let images: Placed<'image'>[] = [];
let texts: Placed<'text'>[] = [];
let annotOps: Record<string, number> = {}; // pdf.js annotation id → op that added it (this session)
const palettes = { highlight: HIGHLIGHT_COLORS, underline: UNDERLINE_COLORS };
const chosenColor = { highlight: HIGHLIGHT_COLORS[0].rgb, underline: UNDERLINE_COLORS[0].rgb };
let pendingImage: { dataUrl: string; width: number; height: number } | undefined;

const TEXT_SIZE = 12; // points
const send = (op: Op) => vscode.postMessage({ type: 'edit', op });
const status = (text: string) => ($('status').textContent = text);
// Added this session: drop the op that made it. Already in the file: remove the annotation itself.
const deleteOpFor = (page: number, id: string): Op =>
  id in annotOps ? { kind: 'deleteOp', opIndex: annotOps[id] } : { kind: 'deleteAnnot', page, ref: id };

// ---------- rendering ----------

window.addEventListener('message', async e => {
  if (e.data.type !== 'load') return;
  ({ images, texts, annotOps } = e.data);
  try {
    const task = pdfjs.getDocument({
      // useWorkerFetch: false — the blob worker can't fetch vscode-resource URLs, so the page loads fonts/CMaps/wasm for it.
      worker, useWorkerFetch: false, data: decodeBase64(e.data.base64), cMapUrl: assets.cMapUrl, cMapPacked: true,
      standardFontDataUrl: assets.standardFontDataUrl, iccUrl: assets.iccUrl, wasmUrl: assets.wasmUrl,
    });
    const next = await task.promise;
    const old = loadingTask;
    [pdf, loadingTask] = [next, task];
    await renderPages();
    await renderIndex(next);
    old?.destroy();
  } catch (err) {
    vscode.postMessage({ type: 'error', message: (err as Error).message });
  }
});

function decodeBase64(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Lazy rendering: every page gets an empty, correctly sized slot right away; only the slots on screen
// (plus one screen above and below) are painted, and slots that scroll far away are emptied to free memory.
type Slot = { index: number; visible: boolean; done: boolean; rendering?: Promise<void> };
const slots = new WeakMap<HTMLElement, Slot>();
let observer: IntersectionObserver | undefined;
// Page sizes in points, kept across re-renders so the layout doesn't jump after an edit or zoom.
let pageSizes: [number, number][] = [];
const currentScale = () => zoom * (96 / 72); // 100% = real size on screen

async function renderPages() {
  if (!pdf) return;
  const gen = ++renderGen;
  const doc = pdf;
  const scale = currentScale();
  if (pageSizes.length !== doc.numPages) {
    // Unknown sizes: assume every page is the size of page 1 until it's painted (like Firefox's viewer).
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    pageSizes = Array.from({ length: doc.numPages }, () => [first.width, first.height]);
  }

  const sections = pageSizes.map((size, i) => pageSlot(doc, i, size, scale));
  // Paint what's on screen now before swapping, so edits and zoom don't flash blank pages.
  const onScreen = visiblePageIndices();
  for (const i of onScreen) slots.get(sections[i].querySelector('.page')!)!.visible = true;
  await Promise.all(onScreen.map(i => paint(doc, sections[i].querySelector<HTMLElement>('.page')!, scale)));
  if (gen !== renderGen) return; // a newer render started

  observer?.disconnect();
  const scrollTop = pagesEl.scrollTop;
  pagesEl.replaceChildren(...sections);
  pagesEl.scrollTop = scrollTop;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const pageEl = entry.target as HTMLElement;
      slots.get(pageEl)!.visible = entry.isIntersecting;
      if (entry.isIntersecting) paint(doc, pageEl, scale);
      else clearPage(pageEl);
    }
  }, { root: pagesEl, rootMargin: '100% 0px' });
  for (const s of sections) observer.observe(s.querySelector('.page')!);
}

function visiblePageIndices() {
  const view = pagesEl.getBoundingClientRect();
  return [...pagesEl.querySelectorAll<HTMLElement>('.page')].flatMap((p, i) => {
    const r = p.getBoundingClientRect();
    return r.bottom > view.top && r.top < view.bottom && i < pageSizes.length ? [i] : [];
  });
}

function setPageSize(pageEl: HTMLElement, width: number, height: number, scale: number) {
  pageEl.style.width = `${width}px`;
  pageEl.style.height = `${height}px`;
  pageEl.style.setProperty('--scale-factor', String(scale));
  pageEl.style.setProperty('--user-unit', '1');
  pageEl.style.setProperty('--total-scale-factor', String(scale));
}

function pageSlot(doc: PDFDocumentProxy, i: number, [w, h]: [number, number], scale: number) {
  const pageEl = document.createElement('div');
  pageEl.className = 'page';
  setPageSize(pageEl, w * scale, h * scale, scale);
  slots.set(pageEl, { index: i, visible: false, done: false });

  const header = document.createElement('div');
  header.className = 'page-header';
  header.textContent = `Page ${i + 1} of ${doc.numPages}`;
  if (doc.numPages > 1) {
    const del = document.createElement('button');
    del.textContent = 'Delete page';
    del.addEventListener('click', () => vscode.postMessage({ type: 'deletePage', page: i }));
    header.append(del);
  }
  const wrapper = document.createElement('section');
  wrapper.append(header, pageEl);
  return wrapper;
}

function paint(doc: PDFDocumentProxy, pageEl: HTMLElement, scale: number): Promise<void> {
  const slot = slots.get(pageEl)!;
  if (slot.done) return Promise.resolve();
  slot.rendering ??= (async () => {
    const i = slot.index;
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale });
    pageSizes[i] = [viewport.width / scale, viewport.height / scale];
    setPageSize(pageEl, viewport.width, viewport.height, scale);
    const marks: PageInfo['marks'] = [];
    pageInfo.set(pageEl, { index: i, viewport, marks });

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    pageEl.replaceChildren(canvas, textLayer);

    await page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render();

    // pdf.js doesn't paint sticky notes on the canvas, so draw a marker that shows the note's text.
    for (const a of await page.getAnnotations()) {
      if (a.subtype === 'Highlight' || a.subtype === 'Underline') {
        const q = a.quadPoints as number[] | null; // 8 numbers (4 corners) per marked rectangle
        const boxes = q ? Array.from({ length: q.length / 8 }, (_, k) => {
          const xs = [0, 2, 4, 6].map(j => q[k * 8 + j]), ys = [1, 3, 5, 7].map(j => q[k * 8 + j]);
          return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }) : [a.rect];
        marks.push({ label: a.subtype.toLowerCase(), op: deleteOpFor(i, a.id), boxes });
        continue;
      }
      if (a.subtype !== 'Text') continue;
      const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
      const marker = document.createElement('button');
      marker.className = 'note-marker';
      marker.style.left = `${Math.min(x1, x2)}px`;
      marker.style.top = `${Math.min(y1, y2)}px`;
      marker.title = a.contentsObj?.str ?? '';
      marker.setAttribute('aria-label', `Sticky note: ${marker.title}`);
      marker.textContent = '🗒';
      marker.addEventListener('click', () => marker.classList.toggle('open'));
      marker.addEventListener('keydown', e => e.key === 'Delete' && send(deleteOpFor(i, a.id)));
      const popup = document.createElement('div');
      popup.className = 'note-popup';
      popup.textContent = marker.title;
      marker.append(popup);
      const del = document.createElement('button');
      del.className = 'note-delete';
      del.style.left = `${Math.min(x1, x2) + 22}px`;
      del.style.top = marker.style.top;
      del.textContent = '✕';
      del.title = del.ariaLabel = 'Delete note';
      del.addEventListener('click', () => send(deleteOpFor(i, a.id)));
      pageEl.append(marker, del);
    }

    for (const img of images) if (img.page === i) pageEl.append(imageBox(pageEl, viewport, img));

    slot.done = true;
  })().catch(err => {
    if (doc === pdf) vscode.postMessage({ type: 'error', message: `Page ${slot.index + 1}: ${(err as Error).message}` });
  }).finally(() => {
    slot.rendering = undefined;
    if (!slot.visible) clearPage(pageEl);
  });
  return slot.rendering;
}

function clearPage(pageEl: HTMLElement) {
  const slot = slots.get(pageEl)!;
  if (slot.rendering || !slot.done) return; // an in-flight paint clears itself when it finishes
  pageEl.querySelector('canvas')?.setAttribute('width', '0'); // release the bitmap now, not at GC
  pageEl.replaceChildren();
  slot.done = false;
}

// ---------- index (left sidebar) ----------

type OutlineItem = { title: string; dest: string | unknown[] | null; items: OutlineItem[] };

// Bookmarks: the PDF's own and the ones you add, all renamable and deletable.
async function renderIndex(doc: PDFDocumentProxy) {
  const outline = (await doc.getOutline()) as OutlineItem[] | null;

  const add = iconButton('+', 'Add a bookmark at the current position', () => newBookmark(bookmarks));
  const bookmarks = document.createElement('ul');
  if (outline?.length) addOutline(bookmarks, outline, doc, []);
  else bookmarks.innerHTML = '<li class="hint">No bookmarks yet. Use + to add one here.</li>';

  sidebar.replaceChildren(heading('Bookmarks', add), bookmarks);
}

function heading(text: string, button: HTMLElement) {
  const h = document.createElement('h2');
  h.textContent = text;
  h.append(button);
  return h;
}

function iconButton(text: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.textContent = text;
  b.title = b.ariaLabel = label;
  b.addEventListener('click', onClick);
  return b;
}

function addOutline(list: HTMLElement, items: OutlineItem[], doc: PDFDocumentProxy, parentPath: number[]) {
  items.forEach((item, i) => {
    const path = [...parentPath, i];
    const li = indexEntry(item.title, async () => {
      const target = await resolveDest(doc, item.dest);
      if (target) goTo(target.page, target.y);
      else status('This bookmark points to a page that no longer exists');
    }, {
      rename: { value: item.title, placeholder: 'Bookmark title', commit: title => title && send({ kind: 'renameBookmark', path, title }) },
      remove: () => send({ kind: 'deleteBookmark', path }),
    });
    if (item.items.length) {
      const sub = document.createElement('ul');
      addOutline(sub, item.items, doc, path);
      li.append(sub);
    }
    list.append(li);
  });
}

type Rename = { value: string; placeholder: string; commit: (title: string) => void };

// An index entry: click to jump; ✎ or F2 renames; ✕ or Delete removes.
function indexEntry(label: string, onClick: () => void, opts: { rename: Rename; remove: () => void }) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'entry';
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = go.title = label;
  go.addEventListener('click', onClick);
  go.addEventListener('keydown', e => {
    if (e.key === 'F2') editInRow(row, opts.rename);
    if (e.key === 'Delete') opts.remove();
  });
  row.append(go, iconButton('✎', `Rename "${label}"`, () => editInRow(row, opts.rename)));
  row.append(iconButton('✕', `Delete bookmark "${label}"`, opts.remove));
  li.append(row);
  return li;
}

// Swaps a row's content for a text field. Enter or leaving the field saves (if changed), Escape cancels.
function editInRow(row: HTMLElement, { value, placeholder, commit }: Rename) {
  const before = [...row.childNodes];
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = value;
  input.placeholder = placeholder;
  input.ariaLabel = placeholder;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    row.replaceChildren(...before);
    if (save && title !== value.trim()) commit(title);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  row.replaceChildren(input);
  input.focus();
  input.select();
}

// "+" in Bookmarks: new bookmark at the top of what's on screen, titled by the user.
function newBookmark(list: HTMLElement) {
  const viewTop = pagesEl.getBoundingClientRect().top + 40;
  const pageEl = [...pagesEl.querySelectorAll<HTMLElement>('.page')].find(p => p.getBoundingClientRect().bottom > viewTop);
  if (!pageEl || !pageInfo.has(pageEl)) return status('Wait for the page to finish loading');
  const r = pageEl.getBoundingClientRect();
  const { index } = pageInfo.get(pageEl)!;
  const y = pdfPoint(pageEl, r.left, Math.max(viewTop, r.top))[1];
  list.querySelector('.hint')?.remove();
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'entry';
  li.append(row);
  list.prepend(li);
  editInRow(row, {
    value: '', placeholder: `Bookmark title (page ${index + 1})`,
    commit: title => send({ kind: 'addBookmark', page: index, y, title }),
  });
  // Cancelled (Escape or empty): drop the placeholder row.
  row.addEventListener('focusout', () => setTimeout(() => !row.querySelector('button') && li.remove()));
}

// Outline destination → page index and, when given, the y position on that page (PDF points).
async function resolveDest(doc: PDFDocumentProxy, dest: OutlineItem['dest']) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!explicit) return null;
    const [ref, mode, ...args] = explicit as [unknown, { name: string } | undefined, ...(number | null)[]];
    const page = typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never);
    const y = mode?.name === 'XYZ' ? args[1] : mode?.name === 'FitH' || mode?.name === 'FitBH' ? args[0] : null;
    return { page, y: y ?? undefined };
  } catch {
    return null; // e.g. the bookmark's page was deleted
  }
}

async function goTo(page: number, y?: number) {
  const pageEl = pagesEl.querySelectorAll<HTMLElement>('.page')[page];
  if (!pageEl || !pdf) return;
  // The target page may not be painted yet, so ask pdf.js for its real viewport.
  const viewport = (await pdf.getPage(page + 1)).getViewport({ scale: currentScale() });
  const dy = y === undefined ? 0 : viewport.convertToViewportPoint(0, y)[1];
  const top = pageEl.getBoundingClientRect().top - pagesEl.getBoundingClientRect().top + pagesEl.scrollTop;
  pagesEl.scrollTo({ top: top + dy - (y === undefined ? 30 : 8) }); // 30 = room for the "Page N" header
}

$('toggleIndex').addEventListener('click', e => {
  const hidden = document.body.classList.toggle('index-hidden');
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(!hidden));
});

// An inserted image: drag to move, drag the corner (or Shift+arrows) to resize, arrows to move. Each change is one undoable edit.
function imageBox(pageEl: HTMLElement, viewport: PageViewport, img: Placed<'image'>) {
  const s = viewport.scale;
  const [left, top] = viewport.convertToViewportPoint(img.x, img.y + img.h);
  const box = document.createElement('div');
  box.className = 'image-box';
  box.tabIndex = 0;
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'Inserted image. Arrow keys move it, Shift+arrow keys resize it.');
  Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${img.w * s}px`, height: `${img.h * s}px` });
  const pic = document.createElement('img');
  pic.src = img.dataUrl;
  pic.alt = '';
  pic.draggable = false;
  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  box.append(pic, handle);

  const ratio = img.h / img.w;
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));
  // Moves/resizes the box in CSS px, kept inside the page and at the image's aspect ratio.
  const place = (l: number, t: number, w: number) => {
    w = clamp(w, 16, Math.min(pageEl.clientWidth - l, (pageEl.clientHeight - t) / ratio));
    box.style.width = `${w}px`;
    box.style.height = `${w * ratio}px`;
    box.style.left = `${clamp(l, 0, pageEl.clientWidth - w)}px`;
    box.style.top = `${clamp(t, 0, pageEl.clientHeight - w * ratio)}px`;
  };
  // Exact (unrounded) CSS px; offsetLeft & co. round to whole pixels and would make the image drift.
  const px = (k: 'left' | 'top' | 'width' | 'height') => parseFloat(box.style[k]);
  const commit = () => {
    const [x, y] = viewport.convertToPdfPoint(px('left'), px('top') + px('height'));
    vscode.postMessage({ type: 'moveImage', opIndex: img.opIndex, rect: { x, y, w: px('width') / s, h: px('height') / s } });
  };

  box.addEventListener('pointerdown', e => {
    e.preventDefault();
    box.focus();
    box.setPointerCapture(e.pointerId);
    const resizing = e.target === handle;
    const start = { x: e.clientX, y: e.clientY, l: px('left'), t: px('top'), w: px('width') };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      if (resizing) place(start.l, start.t, start.w + dx);
      else place(start.l + dx, start.t + dy, start.w);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', () => {
      box.removeEventListener('pointermove', move);
      if (moved) commit();
    }, { once: true });
  });

  box.addEventListener('keydown', e => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const step = 5;
    if (e.shiftKey) place(px('left'), px('top'), px('width') + (d[0] || -d[1]) * step);
    else place(px('left') + d[0] * step, px('top') + d[1] * step, px('width'));
    commit();
  });
  return box;
}

// ---------- toolbar ----------

function setTool(next: Tool) {
  tool = next;
  document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === next)));
  document.body.dataset.tool = next;
  status({ select: 'Click a highlight, underline or added text to delete it', highlight: 'Select text to highlight', underline: 'Select text to underline',
    text: 'Click on a page to add text', note: 'Click on a page to add a note', image: 'Choose an image…' }[next]);
}

document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(b => b.addEventListener('click', () => {
  setTool(b.dataset.tool as Tool);
  if (tool === 'image') imageInput.click();
}));

// Colour swatches: picking one also switches to that tool.
document.querySelectorAll<HTMLElement>('.swatches').forEach(group => {
  const kind = group.dataset.for as 'highlight' | 'underline';
  for (const c of palettes[kind]) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = b.ariaLabel = c.name;
    b.style.background = `rgb(${c.rgb.map(v => Math.round(v * 255)).join(' ')})`;
    b.setAttribute('aria-pressed', String(c === palettes[kind][0]));
    b.addEventListener('click', () => {
      chosenColor[kind] = c.rgb;
      group.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      setTool(kind);
    });
    group.append(b);
  }
});

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  imageInput.value = '';
  if (!file) return setTool('select');
  const dataUrl = await new Promise<string>(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  pendingImage = { dataUrl, width: img.naturalWidth, height: img.naturalHeight };
  status('Click on a page to place the image');
});

function setZoom(z: number) {
  zoom = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
  $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  renderPages();
}
let zoomBeforeTwoPages = 1;
$('twoPages').addEventListener('click', e => {
  const on = pagesEl.classList.toggle('two-pages');
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
  const first = pagesEl.querySelector<HTMLElement>('.page');
  if (!first) return;
  if (!on) return setZoom(zoomBeforeTwoPages);
  // Fit both pages to the width: page width at 100%, two of them plus padding and gap.
  zoomBeforeTwoPages = zoom;
  const fit = (pagesEl.clientWidth - 2 * 16 - 16) / (2 * first.offsetWidth / zoom);
  if (fit < zoom) setZoom(Math.floor(fit * 100) / 100);
});
$('zoomIn').addEventListener('click', () => setZoom(zoom + 0.25));
$('zoomOut').addEventListener('click', () => setZoom(zoom - 0.25));

// ---------- page interactions ----------

function pdfPoint(pageEl: HTMLElement, clientX: number, clientY: number) {
  const r = pageEl.getBoundingClientRect();
  return pageInfo.get(pageEl)!.viewport.convertToPdfPoint(clientX - r.left, clientY - r.top) as [number, number];
}

pagesEl.addEventListener('mouseup', () => {
  if (tool !== 'highlight' && tool !== 'underline') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const pageEl = (range.startContainer.parentElement)?.closest<HTMLElement>('.page');
  if (!pageEl) return;
  const pr = pageEl.getBoundingClientRect();
  // shortcut: a selection that spans pages is only marked on the page where it starts.
  const quads = [...range.getClientRects()]
    .filter(r => r.width > 1 && r.height > 1 && r.top < pr.bottom && r.bottom > pr.top)
    .map(r => {
      const [x1, y1] = pdfPoint(pageEl, r.left, r.top);
      const [x2, y2] = pdfPoint(pageEl, r.right, r.bottom);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    });
  sel.removeAllRanges();
  if (quads.length) send({ kind: tool, page: pageInfo.get(pageEl)!.index, quads, color: chosenColor[tool] });
});

pagesEl.addEventListener('click', e => {
  const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.page');
  if (!pageEl || !pageInfo.has(pageEl) || (e.target as HTMLElement).closest('.note-marker, .note-delete, .delete-offer, .inline-input, .image-box')) return;
  const { index, viewport } = pageInfo.get(pageEl)!;
  const [x, y] = pdfPoint(pageEl, e.clientX, e.clientY);

  // Also with Highlight/Underline: a plain click (no text selected) there is not a new mark.
  if ((tool === 'select' || tool === 'highlight' || tool === 'underline') && window.getSelection()?.isCollapsed !== false) {
    const hit = deletableAt(pageEl, x, y);
    if (hit) offerDelete(pageEl, e, hit);
  }

  if (tool === 'image' && pendingImage) {
    const w = Math.min(200, pendingImage.width); // points
    const h = w * pendingImage.height / pendingImage.width;
    send({ kind: 'image', page: index, x, y: y - h, w, h, dataUrl: pendingImage.dataUrl });
    pendingImage = undefined;
    setTool('select');
  } else if (tool === 'text' || tool === 'note') {
    const kind = tool;
    inlineInput(pageEl, e, kind === 'text' ? TEXT_SIZE * viewport.scale : 13, value => {
      if (kind === 'text') send({ kind, page: index, x, y: y - TEXT_SIZE * 0.8, text: value, size: TEXT_SIZE }); // y is the first baseline
      else send({ kind, page: index, x, y, contents: value });
    });
  }
});

const measure = document.createElement('canvas').getContext('2d')!;

// Bounds of an added text in PDF points; the same font metrics as Helvetica, close enough to click on.
function textBox(t: Placed<'text'>) {
  measure.font = `${t.size}px Helvetica, Arial, sans-serif`;
  const lines = t.text.split('\n');
  const w = Math.max(...lines.map(l => measure.measureText(l).width));
  return [t.x, t.y - (lines.length - 1) * t.size * 1.2 - t.size * 0.25, t.x + w, t.y + t.size * 0.8];
}

// The topmost deletable thing under a point: added text is drawn over highlights and underlines.
function deletableAt(pageEl: HTMLElement, x: number, y: number): Deletable | undefined {
  const { index, marks } = pageInfo.get(pageEl)!;
  const inside = ([x1, y1, x2, y2]: number[]) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
  const text = texts.filter(t => t.page === index && inside(textBox(t))).pop();
  if (text) return { label: 'text', op: { kind: 'deleteOp', opIndex: text.opIndex } };
  return marks.filter(m => m.boxes.some(inside)).pop();
}

// A "Delete …" button at the click. Escape or clicking elsewhere dismisses it; Cmd+Z undoes the delete.
function offerDelete(pageEl: HTMLElement, e: MouseEvent, { label, op }: Deletable) {
  const r = pageEl.getBoundingClientRect();
  const b = document.createElement('button');
  b.className = 'delete-offer';
  b.textContent = `Delete ${label}`;
  b.style.left = `${e.clientX - r.left}px`;
  b.style.top = `${e.clientY - r.top}px`;
  // Removed only on blur: removing a focused button fires blur, and a second remove() inside it throws.
  b.addEventListener('click', () => { send(op); b.blur(); });
  b.addEventListener('keydown', ev => ev.key === 'Escape' && b.blur());
  b.addEventListener('blur', () => b.remove());
  pageEl.append(b);
  b.focus();
}

// Enter commits, Shift+Enter adds a line, Escape cancels.
function inlineInput(pageEl: HTMLElement, e: MouseEvent, fontPx: number, commit: (value: string) => void) {
  const r = pageEl.getBoundingClientRect();
  const input = document.createElement('textarea');
  input.className = 'inline-input';
  input.rows = 1;
  input.placeholder = tool === 'note' ? 'Note…' : 'Text…';
  input.setAttribute('aria-label', input.placeholder);
  input.style.left = `${e.clientX - r.left}px`;
  input.style.top = `${e.clientY - r.top}px`;
  input.style.fontSize = `${fontPx}px`;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trimEnd();
    input.remove();
    if (save && value) commit(value);
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  pageEl.append(input);
  input.focus();
}

setTool('select');
vscode.postMessage({ type: 'ready' });
