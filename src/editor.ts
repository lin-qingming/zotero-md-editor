/**
 * Markdown Editor -- the page inside an editor tab (resource://zotero-md-editor/editor.html).
 *
 * Wraps Vditor in its IR mode, which renders Markdown in place the way Typora does. This page is
 * unprivileged: the host (main.ts) owns the file and talks to it by postMessage (see types.ts).
 *
 * Images: the note links them by relative path ("note.assets/x.png"), which this page has no
 * right to read. Each rendered <img> with a local src is handed to the host, which reads the file
 * and returns a data: URL. Only the element's src changes; the Markdown keeps the relative path.
 */

import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { MESSAGE_KEY, type Envelope, type ToHost, type ToPage } from './types';

const CDN = 'resource://zotero-md-editor/vditor';

const TOOLBAR = [
	'headings', 'bold', 'italic', 'strike', 'link', '|',
	'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
	'quote', 'line', 'code', 'inline-code', 'table', 'upload', '|',
	'undo', 'redo', '|',
	'edit-mode', 'outline',
];

const MIME_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/bmp': 'bmp',
	'image/tiff': 'tiff',
	'image/avif': 'avif',
	'image/heic': 'heic',
};

/** Attribute holding an <img>'s original src once we've swapped in a data: URL */
const ORIGINAL_SRC = 'data-md-src';

let vditor: Vditor | null = null;
/** The Markdown the host last heard about, so a final flush sends only unreported edits */
let reported = '';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// ---------------------------------------------------------------------------------------------
// Talking to the host

let nextRequestID = 1;
const pending = new Map<number, (value: string | null) => void>();

function post(message: ToHost) {
	let envelope: Envelope = { [MESSAGE_KEY]: 'toHost', message };
	window.postMessage(envelope, '*');
}

function request(make: (requestID: number) => ToHost): Promise<string | null> {
	let requestID = nextRequestID++;
	return new Promise((resolve) => {
		pending.set(requestID, resolve);
		post(make(requestID));
	});
}

window.addEventListener('message', (event) => {
	let data = event.data as Envelope | undefined;
	// Not checked against event.source: a message the host posts has the host's window as source
	if (!data || data[MESSAGE_KEY] !== 'toPage') {
		return;
	}
	let message = data.message as ToPage;
	switch (message.action) {
		case 'init':
			init(message.markdown, message.lang, message.notice);
			break;
		case 'setValue':
			vditor?.setValue(message.markdown, true);
			reported = vditor?.getValue() ?? '';
			break;
		case 'focus':
			vditor?.focus();
			break;
		case 'assetSaved':
			pending.get(message.requestID)?.(message.link);
			pending.delete(message.requestID);
			break;
		case 'assetLoaded':
			pending.get(message.requestID)?.(message.dataURL);
			pending.delete(message.requestID);
			break;
	}
});

// ---------------------------------------------------------------------------------------------
// Editor

function themes() {
	let dark = darkQuery.matches;
	return {
		ui: dark ? 'dark' as const : 'classic' as const,
		content: dark ? 'dark' : 'light',
		code: dark ? 'github-dark' : 'github',
	};
}

function init(markdown: string, lang: string, notice: string | null) {
	if (notice) {
		let banner = document.getElementById('notice')!;
		banner.textContent = notice;
		banner.hidden = false;
	}

	let t = themes();
	vditor = new Vditor('editor', {
		mode: 'ir',
		value: markdown,
		cdn: CDN,
		lang: lang as any,
		theme: t.ui,
		icon: 'ant',
		height: '100%',
		cache: { enable: false },
		toolbar: TOOLBAR,
		toolbarConfig: { pin: true },
		outline: { enable: false, position: 'left' },
		preview: {
			theme: { current: t.content, path: `${CDN}/dist/css/content-theme` },
			hljs: { style: t.code, lineNumber: false },
			math: { engine: 'KaTeX' },
			markdown: { sanitize: true },
		},
		upload: {
			multiple: true,
			// Used for drops and the toolbar's upload button; pastes are handled in onPaste
			handler: async (files: File[]) => {
				await insertFiles(files);
				return null;
			},
		},
		input: (value: string) => {
			reported = value;
			post({ action: 'change', markdown: value });
		},
		after: () => {
			reported = vditor!.getValue();
			observeImages();
			post({ action: 'initialized' });
		},
	});
}

/** Save files beside the note and insert links to them at the cursor */
async function insertFiles(files: File[]) {
	if (!vditor) {
		return;
	}
	let links: string[] = [];
	for (let file of files) {
		let name = assetName(file);
		let base64 = new Uint8Array(await file.arrayBuffer()).toBase64();
		let link = await request((requestID) => ({ action: 'saveAsset', requestID, name, base64 }));
		if (!link) {
			continue;
		}
		let label = name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
		links.push(file.type.startsWith('image/') ? `![${label}](${link})` : `[${label}](${link})`);
	}
	if (links.length) {
		vditor.insertValue(links.join('\n\n'));
		reported = vditor.getValue();
		post({ action: 'change', markdown: reported });
	}
}

/** Keep a real file name; give clipboard images ("image.png") a timestamped one, as Typora does */
function assetName(file: File): string {
	let ext = MIME_EXTENSIONS[file.type] || file.name.match(/\.([A-Za-z0-9]+)$/)?.[1] || 'png';
	if (file.name && !/^(image|blob)(\.\w+)?$/i.test(file.name)) {
		return file.name;
	}
	let d = new Date();
	let pad = (n: number, width = 2) => String(n).padStart(width, '0');
	let stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
		+ `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
	return `image-${stamp}.${ext}`;
}

// ---------------------------------------------------------------------------------------------
// Local images

const loadedAssets = new Map<string, Promise<string | null>>();

function isLocalSrc(src: string): boolean {
	// Relative paths, absolute paths and file:// -- not web, data: or blob: URLs
	return !!src && (/^file:/i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src) || /^[a-z]:[\\/]/i.test(src));
}

async function resolveImage(img: HTMLImageElement) {
	let src = img.getAttribute(ORIGINAL_SRC) ?? img.getAttribute('src') ?? '';
	if (!isLocalSrc(src) || img.getAttribute(ORIGINAL_SRC) === src && img.src.startsWith('data:')) {
		return;
	}
	let promise = loadedAssets.get(src);
	if (!promise) {
		promise = request((requestID) => ({ action: 'loadAsset', requestID, src }));
		loadedAssets.set(src, promise);
	}
	let dataURL = await promise;
	if (dataURL === null) {
		// Let a later render retry, e.g. once a sync has downloaded the file
		loadedAssets.delete(src);
		return;
	}
	img.setAttribute(ORIGINAL_SRC, src);
	img.setAttribute('src', dataURL);
}

function observeImages() {
	let root = document.getElementById('editor')!;
	let scan = (node: Node) => {
		if (node instanceof HTMLImageElement) {
			void resolveImage(node);
		}
		else if (node instanceof Element) {
			node.querySelectorAll('img').forEach((img) => void resolveImage(img));
		}
	};
	new MutationObserver((records) => {
		for (let record of records) {
			if (record.type === 'attributes') {
				let img = record.target as HTMLImageElement;
				// Vditor rewrote the src (the user edited the link) -- forget our copy
				if (!img.getAttribute('src')?.startsWith('data:')) {
					img.removeAttribute(ORIGINAL_SRC);
				}
				scan(img);
			}
			else {
				record.addedNodes.forEach(scan);
			}
		}
	}).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
	scan(root);
}

// ---------------------------------------------------------------------------------------------
// Input

// A screenshot on the clipboard arrives as a File with no accompanying text. When there is text
// as well (e.g. cells copied from a spreadsheet, which also carry a picture of themselves), the
// text is what was meant, so leave it to Vditor.
function onPaste(event: ClipboardEvent) {
	let data = event.clipboardData;
	if (!data || !vditor) {
		return;
	}
	let images = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
	if (!images.length || data.getData('text/plain').trim()) {
		return;
	}
	event.preventDefault();
	event.stopImmediatePropagation();
	void insertFiles(images);
}

function isAccelKey(event: KeyboardEvent | MouseEvent) {
	return navigator.platform.startsWith('Mac') ? event.metaKey : event.ctrlKey;
}

function onKeyDown(event: KeyboardEvent) {
	if (isAccelKey(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
		event.preventDefault();
		post({ action: 'save' });
	}
}

// Links open in the system browser on Cmd/Ctrl+click; a plain click just places the cursor
function onClick(event: MouseEvent) {
	let link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
	if (!link) {
		return;
	}
	event.preventDefault();
	if (isAccelKey(event)) {
		post({ action: 'openURL', url: link.href });
	}
}

document.addEventListener('paste', onPaste, true);
document.addEventListener('keydown', onKeyDown, true);
document.addEventListener('click', onClick, true);
// A file dropped outside the editing area would otherwise replace this page with the file
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Called synchronously by the host as the tab closes: Vditor reports input only after a short
// delay, so the last keystrokes may not have been posted yet. Returns them, or null if none.
(window as any).mdEditorFlush = (): string | null => {
	if (!vditor) {
		return null;
	}
	let value = vditor.getValue();
	if (value === reported) {
		return null;
	}
	reported = value;
	return value;
};

darkQuery.addEventListener('change', () => {
	let t = themes();
	vditor?.setTheme(t.ui, t.content, t.code);
});
