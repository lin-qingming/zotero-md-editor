// Build the plugin into build/addon, and with --xpi also package it.
//
//   addon/          static files copied as-is (bootstrap.js, editor.html, locale, ...)
//   src/main.ts     -> content/main.js    runs in Zotero's privileged scope
//   src/editor.ts   -> content/editor.js  runs inside the editor tab's iframe (bundles Vditor)
//   Vditor's lazily loaded runtime (Lute, i18n, icons, highlighting, KaTeX, Mermaid) is copied
//   to content/vditor/dist, which is what Vditor's `cdn` option points at.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'addon');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vditorDist = path.join(root, 'node_modules', 'vditor', 'dist');

// Only what a note realistically needs. MathJax, Graphviz, ECharts, etc. add ~10 MB and are
// only fetched when a document uses them, so leaving them out just disables those blocks.
const VDITOR_ASSETS = [
	'js/lute',
	'js/i18n',
	'js/icons',
	'js/highlight.js',
	'js/katex',
	'js/mermaid',
	'css/content-theme',
];

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'addon'), out, { recursive: true });

let manifestPath = path.join(out, 'manifest.json');
let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

for (let rel of VDITOR_ASSETS) {
	fs.cpSync(path.join(vditorDist, rel), path.join(out, 'content', 'vditor', 'dist', rel), { recursive: true });
}

const common = {
	bundle: true,
	target: 'firefox115',
	charset: 'utf8',
	legalComments: 'none',
	logLevel: 'warning',
};

await build({
	...common,
	entryPoints: [path.join(root, 'src', 'main.ts')],
	outfile: path.join(out, 'content', 'main.js'),
	format: 'iife',
	globalName: 'MdEditor',
});

await build({
	...common,
	entryPoints: [path.join(root, 'src', 'editor.ts')],
	outfile: path.join(out, 'content', 'editor.js'),
	format: 'iife',
	minify: true,
	loader: { '.svg': 'dataurl', '.png': 'dataurl', '.gif': 'dataurl' },
});

console.log(`built ${path.relative(root, out)} (v${pkg.version})`);

if (process.argv.includes('--xpi')) {
	let xpi = path.join(root, `zotero-md-editor-${pkg.version}.xpi`);
	fs.rmSync(xpi, { force: true });
	// manifest.json must sit at the archive root
	execFileSync('zip', ['-r', '-q', '-X', xpi, '.'], { cwd: out });
	console.log(path.relative(root, xpi));
}
