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
import { MESSAGE_KEY, type Envelope, type Insertion, type ItemHint, type PageStrings, type RequestToHost, type ToHost, type ToPage } from './types';

const CDN = 'resource://zotero-md-editor/vditor';

const ZOTERO_ICON = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 2.5h10v2.2L6.4 11.3H13v2.2H3v-2.2l6.6-6.6H3z"/></svg>';

function toolbar(strings: PageStrings) {
	return [
		'headings', 'bold', 'italic', 'strike', 'link', '|',
		'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
		'quote', 'line', 'code', 'inline-code', 'table', 'upload', '|',
		{
			name: 'zotero-item',
			tip: strings.insertItem,
			tipPosition: 's',
			icon: ZOTERO_ICON,
			click: () => void pickItems(),
		},
		'|',
		'undo', 'redo', '|',
		'edit-mode', 'outline',
	];
}

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
const pending = new Map<number, (value: unknown) => void>();

function post(message: ToHost) {
	let envelope: Envelope = { [MESSAGE_KEY]: 'toHost', message };
	window.postMessage(envelope, '*');
}

type Request = RequestToHost extends infer R ? R extends { requestID: number } ? Omit<R, 'requestID'> : never : never;

function request<T>(message: Request): Promise<T> {
	let requestID = nextRequestID++;
	return new Promise((resolve) => {
		pending.set(requestID, resolve as (value: unknown) => void);
		post({ ...message, requestID } as ToHost);
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
			init(message.markdown, message.lang, message.notice, message.strings);
			break;
		case 'setValue':
			vditor?.setValue(message.markdown, true);
			reported = vditor?.getValue() ?? '';
			break;
		case 'focus':
			vditor?.focus();
			break;
		case 'insertAt':
			placeCaretAt(message.x, message.y);
			insertMarkdown(message.markdown, message.block);
			break;
		case 'reply':
			pending.get(message.requestID)?.(message.value);
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

function init(markdown: string, lang: string, notice: string | null, strings: PageStrings) {
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
		toolbar: toolbar(strings),
		hint: {
			// Typing "@" and part of a title, creator or year offers matching Zotero items.
			// The entries are our own escaped HTML, not Markdown.
			parse: false,
			extend: [{ key: '@', hint: searchHints }],
		},
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
		let link = await request<string | null>({ action: 'saveAsset', name, base64 });
		if (!link) {
			continue;
		}
		let label = name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
		links.push(file.type.startsWith('image/') ? `![${label}](${link})` : `[${label}](${link})`);
	}
	if (links.length) {
		insertMarkdown(links.join('\n\n'));
	}
}

/**
 * Insert at the cursor and report the change (insertValue doesn't fire Vditor's input callback).
 * Block content goes into a new paragraph after the current one: inserted mid-paragraph, a quote
 * or list would be read as plain text.
 */
function insertMarkdown(markdown: string, block = false) {
	if (!vditor) {
		return;
	}
	if (block) {
		moveToNewBlock();
	}
	vditor.insertValue(markdown);
	reported = vditor.getValue();
	post({ action: 'change', markdown: reported });
}

// ---------------------------------------------------------------------------------------------
// Zotero items

function escapeHTML(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function searchHints(query: string) {
	let hints = await request<ItemHint[] | null>({ action: 'searchItems', query });
	return (hints || []).map((hint) => ({
		value: hint.markdown,
		html: `<span class="md-hint-title">${escapeHTML(hint.title)}</span>`
			+ (hint.detail ? ` <span class="md-hint-detail">${escapeHTML(hint.detail)}</span>` : ''),
	}));
}

async function pickItems() {
	// The picker is a modal window, so remember where the cursor was
	let selection = window.getSelection();
	let range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
	let insertion = await request<Insertion | null>({ action: 'pickItems' });
	if (!insertion || !vditor) {
		return;
	}
	vditor.focus();
	if (range) {
		selection!.removeAllRanges();
		selection!.addRange(range);
	}
	insertMarkdown(insertion.markdown, insertion.block);
}

/** The top-level block (paragraph, heading, list, ...) holding the cursor */
function currentBlock(): Element | null {
	let node = window.getSelection()?.anchorNode;
	let element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
	return element?.closest('.vditor-reset > *') ?? null;
}

/** Unless the cursor is in an empty paragraph already, add one after its block and move there */
function moveToNewBlock() {
	let block = currentBlock();
	if (!block || block.tagName === 'P' && !block.textContent?.replace(/\u200b/g, '').trim()) {
		return;
	}
	let paragraph = document.createElement('p');
	paragraph.setAttribute('data-block', '0');
	paragraph.append('\u200b');
	block.after(paragraph);
	let range = document.createRange();
	range.setStart(paragraph.firstChild!, 1);
	range.collapse(true);
	let selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Put the cursor where something was dropped */
function placeCaretAt(x: number, y: number) {
	let position = document.caretPositionFromPoint(x, y);
	let editable = document.querySelector('#editor .vditor-reset[contenteditable="true"]');
	if (!position || !editable?.contains(position.offsetNode)) {
		return;
	}
	vditor?.focus();
	let range = document.createRange();
	range.setStart(position.offsetNode, position.offset);
	range.collapse(true);
	let selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
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
		promise = request<string | null>({ action: 'loadAsset', src });
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

/**
 * The destination of the link under the pointer. In IR mode a link isn't an <a> but a
 * span[data-type="a"] whose raw Markdown includes the URL in a marker span; the other modes
 * render real anchors.
 */
function linkAt(target: Element | null): string | null {
	let irLink = target?.closest?.('.vditor-ir__node[data-type="a"]');
	if (irLink) {
		return irLink.querySelector('.vditor-ir__marker--link')?.textContent?.trim() || null;
	}
	let anchor = target?.closest?.('a[href]');
	return anchor ? anchor.getAttribute('href') : null;
}

// Links -- to Zotero items or the web -- open on Cmd/Ctrl+click, as in Typora; a plain click
// just places the cursor for editing
function onClick(event: MouseEvent) {
	let target = event.target as Element | null;
	let url = linkAt(target);
	if (!url) {
		return;
	}
	if (target?.closest?.('a[href]')) {
		// Never let the page itself navigate
		event.preventDefault();
	}
	if (isAccelKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		post({ action: 'openURL', url });
	}
}

// Show which links are live while Cmd/Ctrl is held
function onAccelChange(event: KeyboardEvent) {
	document.body.classList.toggle('md-accel', isAccelKey(event));
}

document.addEventListener('paste', onPaste, true);
document.addEventListener('keydown', onKeyDown, true);
document.addEventListener('click', onClick, true);
document.addEventListener('keydown', onAccelChange);
document.addEventListener('keyup', onAccelChange);
window.addEventListener('blur', () => document.body.classList.remove('md-accel'));
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
