import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const watch = process.argv.includes('--watch');
const pdfjs = 'node_modules/pdfjs-dist';

// Files pdf.js fetches at runtime: worker, fonts, CMaps, ICC profiles, wasm image decoders.
cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, 'dist/pdf.worker.min.mjs');
for (const dir of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) cpSync(`${pdfjs}/${dir}`, `dist/${dir}`, { recursive: true });
cpSync(`${pdfjs}/web/pdf_viewer.css`, 'dist/pdf_viewer.css');
cpSync('webview/style.css', 'dist/style.css');

const builds = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'esm' },
].map(o => ({ ...o, bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' }));

if (watch) for (const o of builds) await (await esbuild.context(o)).watch();
else await Promise.all(builds.map(o => esbuild.build(o)));
