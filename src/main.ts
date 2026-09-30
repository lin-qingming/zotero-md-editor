/**
 * Markdown Editor -- Zotero-side host. Loaded by bootstrap.js; defines the global MdEditor.
 *
 * Why images go next to the file: Zotero syncs a stored attachment as its whole storage
 * directory. WebDAV always uploads storage/<KEY>/ as <KEY>.zip, and Zotero File Storage does the
 * same for text/* attachments (Zotero.Sync.Storage.Mode.ZFS._isZipUpload). Zotero.File.zipDirectory
 * recurses into subdirectories and skips dotfiles, and _processZipDownload recreates them. So an
 * image written to storage/<KEY>/<note>.assets/ and linked as "<note>.assets/x.png" travels with
 * the note to every device -- the same "./${filename}.assets/" layout Typora uses. An upload is
 * only triggered when the .md itself changes, which inserting the link always does.
 *
 * Hooks:
 *  - Zotero.FileHandlers.open, which ZoteroPane.viewAttachment calls once the file is present
 *    (after downloading it on demand), so double-click and "View File" land here.
 *  - Zotero_Tabs.getState, to keep our tabs out of the saved session: Zotero restores tabs before
 *    plugins load and would throw on a tab type it has no restoreState hook for.
 */

import { markdownForAnnotations, markdownForItems, parseRectLink, searchItems, type DraggedAnnotation } from './links';
import { MESSAGE_KEY, type Envelope, type Insertion, type RequestToHost, type ToHost, type ToPage } from './types';

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Components: any;

// No hyphen: Zotero_Tabs.parseTabType() reads "a-b" as content type "a" in state "b"
const TAB_TYPE = 'mdeditor';
const RESOURCE_HOST = 'zotero-md-editor';
const RESOURCE_ROOT = `resource://${RESOURCE_HOST}/`;
const EDITOR_URL = RESOURCE_ROOT + 'editor.html';
const FTL_FILE = 'zotero-md-editor.ftl';
const PREF_OPEN_IN_ZOTERO = 'extensions.zotero-md-editor.openInZotero';
const SAVE_DELAY_MS = 800;

/** What loadAsset will read and hand to the page, by extension */
const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
};
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const MD_CONTENT_TYPES = new Set(['text/markdown', 'text/x-markdown']);
const MD_EXTENSION = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;

let pluginID = '';
let rootURI = '';
let notifierID: string | null = null;
const menuIDs: string[] = [];

/** Open tabs, by tab ID */
const sessions = new Map<string, Session>();

let origFileHandlersOpen: ((item: any, params: any) => Promise<boolean>) | null = null;
let fileHandlersWrapper: ((item: any, params: any) => Promise<boolean>) | null = null;
/** Overrides the pref for the next FileHandlers.open call, set by our menu commands */
let forcedOpenMode: 'editor' | 'external' | null = null;

/** Windows whose Zotero_Tabs.getState we replaced, with the original */
const patchedWindows = new Map<any, () => any[]>();

export function isMarkdownAttachment(item: any): boolean {
	if (!item || !item.isAttachment() || !item.isFileAttachment()) {
		return false;
	}
	let contentType = (item.attachmentContentType || '').toLowerCase();
	if (MD_CONTENT_TYPES.has(contentType)) {
		return true;
	}
	return MD_EXTENSION.test(item.attachmentFilename || '');
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

export async function startup(data: { id: string; version: string; rootURI: string }) {
	pluginID = data.id;
	rootURI = data.rootURI;

	// Serve content/ as resource://zotero-md-editor/, readable by the unprivileged editor page
	let resProto = Services.io.getProtocolHandler('resource')
		.QueryInterface(Components.interfaces.nsIResProtocolHandler);
	resProto.setSubstitutionWithFlags(
		RESOURCE_HOST,
		Services.io.newURI(rootURI + 'content/'),
		resProto.ALLOW_CONTENT_ACCESS,
	);

	origFileHandlersOpen = Zotero.FileHandlers.open;
	fileHandlersWrapper = async function (this: any, item: any, params: any) {
		let mode = forcedOpenMode
			?? (Zotero.Prefs.get(PREF_OPEN_IN_ZOTERO, true) ? 'editor' : 'external');
		if (mode === 'editor' && isMarkdownAttachment(item)) {
			await openEditor(item);
			return true;
		}
		return origFileHandlersOpen!.call(this, item, params);
	};
	Zotero.FileHandlers.open = fileHandlersWrapper;

	notifierID = Zotero.Notifier.registerObserver({ notify: onNotify }, ['tab', 'item'], 'mdEditor');

	registerMenus();

	for (let win of Zotero.getMainWindows()) {
		onMainWindowLoad(win);
	}
}

export async function shutdown() {
	for (let win of [...patchedWindows.keys()]) {
		onMainWindowUnload(win);
	}

	if (Zotero.FileHandlers.open === fileHandlersWrapper) {
		Zotero.FileHandlers.open = origFileHandlersOpen;
	}
	else if (fileHandlersWrapper) {
		// Another plugin wrapped us; stay in the chain but pass everything through
		forcedOpenMode = 'external';
	}

	if (notifierID) {
		Zotero.Notifier.unregisterObserver(notifierID);
		notifierID = null;
	}

	for (let id of menuIDs.splice(0)) {
		Zotero.MenuManager.unregisterMenu(id);
	}

	Services.io.getProtocolHandler('resource')
		.QueryInterface(Components.interfaces.nsIResProtocolHandler)
		.setSubstitution(RESOURCE_HOST, null);
}

export function onMainWindowLoad(win: any) {
	win.MozXULElement.insertFTLIfNeeded(FTL_FILE);

	let tabs = win.Zotero_Tabs;
	if (tabs && !patchedWindows.has(win)) {
		// Zotero re-titles a tab whose item changes, and needs this hook to do it for our type
		tabs.tabHooks.getTitle[TAB_TYPE] = async (tab: any) => {
			let item = Zotero.Items.get(tab.data.itemID);
			return item ? tabTitle(item) : tab.title;
		};
		let origGetState = tabs.getState;
		patchedWindows.set(win, origGetState);
		tabs.getState = function (this: any) {
			return origGetState.call(this).filter((tab: any) => tab.type !== TAB_TYPE);
		};
	}
}

export function onMainWindowUnload(win: any) {
	for (let session of [...sessions.values()]) {
		if (session.win === win) {
			win.Zotero_Tabs.close(session.tabID);
		}
	}

	let origGetState = patchedWindows.get(win);
	if (origGetState) {
		win.Zotero_Tabs.getState = origGetState;
		delete win.Zotero_Tabs.tabHooks.getTitle[TAB_TYPE];
		patchedWindows.delete(win);
	}

	win.document.querySelector(`link[href="${FTL_FILE}"]`)?.remove();
}

function onNotify(event: string, type: string, ids: (string | number)[]) {
	if (type === 'tab' && event === 'select') {
		for (let id of ids) {
			sessions.get(id as string)?.checkExternalChange();
		}
		return;
	}
	if (type === 'item') {
		for (let session of [...sessions.values()]) {
			if (!ids.includes(session.itemID)) {
				continue;
			}
			if (event === 'delete') {
				session.win.Zotero_Tabs.close(session.tabID);
			}
			else if (event === 'modify') {
				// A sync download or a rename from parent metadata both land here
				session.checkExternalChange();
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Opening

async function openEditor(item: any) {
	let win = Zotero.getMainWindow();
	if (!win) {
		return;
	}
	let tabs = win.Zotero_Tabs;

	for (let session of sessions.values()) {
		if (session.itemID === item.id && session.win === win) {
			tabs.select(session.tabID);
			return;
		}
	}

	let path = await item.getFilePathAsync();
	if (!path) {
		return;
	}

	let tabID = '';
	let { id, container } = tabs.add({
		type: TAB_TYPE,
		title: tabTitle(item),
		data: { itemID: item.id },
		select: true,
		onClose: () => {
			sessions.get(tabID)?.dispose();
			sessions.delete(tabID);
		},
	});
	tabID = id;

	let session = new Session(win, tabID, item, path);
	sessions.set(tabID, session);
	// Not awaited: ZoteroPane.viewAttachment is serialized, so a slow or failed editor load
	// would otherwise hold up every attachment opened after it
	session.load(container).catch((e) => {
		Zotero.logError(e);
		tabs.close(tabID);
	});
}

function tabTitle(item: any): string {
	return item.getField('title') || item.attachmentFilename || '';
}

/** Open through ZoteroPane so a file that isn't downloaded yet gets fetched first */
async function viewWith(win: any, item: any, mode: 'editor' | 'external') {
	forcedOpenMode = mode;
	try {
		await win.ZoteroPane.viewAttachment(item.id);
	}
	finally {
		forcedOpenMode = null;
	}
}

// ---------------------------------------------------------------------------------------------
// An open editor tab

class Session {
	readonly itemID: number;
	private item: any;
	private pageWin: any = null;
	/** Latest Markdown reported by the page; null until the user edits */
	private markdown: string | null = null;
	private dirty = false;
	private lastMtime = 0;
	private saveTimer: number | null = null;
	/** Saves and reloads run one at a time */
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private resolveInitialized: (() => void) | null = null;

	constructor(readonly win: any, readonly tabID: string, item: any, private path: string) {
		this.item = item;
		this.itemID = item.id;
	}

	async load(container: any) {
		// A XUL iframe with type="content" gets a content docshell, so the resource:// page runs
		// unprivileged -- the same setup as Zotero's note editor
		let iframe = this.win.document.createXULElement('iframe');
		iframe.setAttribute('type', 'content');
		iframe.setAttribute('context', 'textbox-contextmenu');
		iframe.style.cssText = 'border: 0; width: 100%; flex-grow: 1; min-height: 0;';
		let domLoaded = new Promise((resolve) => iframe.addEventListener('DOMContentLoaded', resolve, { once: true }));
		iframe.setAttribute('src', EDITOR_URL);
		container.style.display = 'flex';
		container.append(iframe);

		let [markdown] = await Promise.all([this.read(), domLoaded]);
		if (this.closed) {
			return;
		}

		// editor.js has run by DOMContentLoaded, so it's listening already
		this.pageWin = iframe.contentWindow;
		this.pageWin.addEventListener('message', this.onMessage);
		// Items and annotations dragged from Zotero carry their data in types the page can't read
		// on a drop (it can on a paste, so editor.ts handles those)
		this.pageWin.addEventListener('drop', this.onDrop, true);

		let isLinked = this.item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
		let initialized = new Promise<void>((resolve) => this.resolveInitialized = resolve);
		this.post({
			action: 'init',
			markdown,
			lang: vditorLang(),
			notice: isLinked ? await this.l10n('md-editor-linked-notice') : null,
			strings: {
				insertItem: await this.l10n('md-editor-insert-item'),
			},
		});
		await initialized;
		this.post({ action: 'focus' });
	}

	private post(message: ToPage) {
		let envelope: Envelope = { [MESSAGE_KEY]: 'toPage', message };
		this.pageWin?.postMessage(envelope, '*');
	}

	private onMessage = (event: any) => {
		let data = event.data;
		if (event.source !== this.pageWin || !data || data[MESSAGE_KEY] !== 'toHost') {
			return;
		}
		let message = data.message as ToHost;
		switch (message.action) {
			case 'initialized':
				this.resolveInitialized?.();
				break;
			case 'change':
				this.markdown = String(message.markdown);
				this.onChange();
				break;
			case 'save':
				void this.saveNow();
				break;
			case 'saveAsset':
			case 'loadAsset':
			case 'searchItems':
			case 'pickItems':
			case 'annotationsToMarkdown': {
				let requestID = message.requestID;
				this.answer(message)
					.catch((e) => {
						Zotero.logError(e);
						return null;
					})
					.then((value) => this.post({ action: 'reply', requestID, value }));
				break;
			}
			case 'openURL': {
				// ZoteroPane handles zotero://select and zotero://open itself and hands web links to
				// the browser -- the same path links in Zotero's own notes take
				let url = String(message.url);
				let rectLink = parseRectLink(url);
				if (rectLink) {
					// Through viewAttachment, which downloads the file first if needed
					void this.win.ZoteroPane.viewAttachment(rectLink.item.id, null, false, { location: rectLink.location });
				}
				else if (/^(zotero|https?|mailto):/i.test(url)) {
					this.win.ZoteroPane.loadURI(url);
				}
				break;
			}
		}
	};

	private async answer(message: RequestToHost): Promise<unknown> {
		switch (message.action) {
			case 'saveAsset':
				return this.saveAsset(String(message.name), Uint8Array.fromBase64(String(message.base64)));
			case 'loadAsset':
				return this.loadAsset(String(message.src));
			case 'searchItems':
				return searchItems(String(message.query));
			case 'pickItems':
				return this.pickItems();
			case 'annotationsToMarkdown':
				return this.markdownForAnnotations(String(message.json));
		}
	}

	/** Zotero's own item picker, as used for "Change Parent Item" */
	private async pickItems(): Promise<Insertion | null> {
		let io: { dataIn: null; dataOut: number[] | null; [key: string]: unknown } = {
			dataIn: null,
			dataOut: null,
			itemTreeID: 'md-editor-select-items-dialog',
			hideCollections: ['duplicates', 'trash', 'feeds', 'retracted'],
		};
		this.win.openDialog(
			'chrome://zotero/content/selectItemsDialog.xhtml',
			'',
			'chrome,dialog=no,modal,centerscreen,resizable=yes',
			io,
		);
		if (!io.dataOut?.length) {
			return null;
		}
		return markdownForItems(await Zotero.Items.getAsync(io.dataOut));
	}

	private onDrop = (event: any) => {
		let dataTransfer = event.dataTransfer;
		let itemIDs: string = dataTransfer?.getData('zotero/item') || '';
		let annotationsJSON: string = dataTransfer?.getData('zotero/annotation') || '';
		if (!itemIDs && !annotationsJSON) {
			return;
		}
		// Keep Vditor from inserting the plain-text version as well
		event.preventDefault();
		event.stopPropagation();
		let point = { x: event.clientX, y: event.clientY };
		void (async () => {
			let insertion = annotationsJSON
				? await this.markdownForAnnotations(annotationsJSON)
				: markdownForItems(await Zotero.Items.getAsync(itemIDs.split(',').map(Number)));
			if (insertion && !this.closed) {
				this.post({ action: 'insert', ...insertion, point });
			}
		})().catch((e) => Zotero.logError(e));
	};

	private markdownForAnnotations(json: string): Promise<Insertion | null> {
		let parsed = JSON.parse(json);
		return markdownForAnnotations(
			(Array.isArray(parsed) ? parsed : [parsed]) as DraggedAnnotation[],
			(dataURL) => this.saveDataURL(dataURL),
		);
	}

	private async saveDataURL(dataURL: string): Promise<string | null> {
		let match = dataURL.match(/^data:image\/(png|jpeg|webp|gif);base64,(.*)$/);
		if (!match) {
			return null;
		}
		let ext = match[1] === 'jpeg' ? 'jpg' : match[1];
		return this.saveAsset(`annotation-${timestamp()}.${ext}`, Uint8Array.fromBase64(match[2]));
	}

	private async read(): Promise<string> {
		let text: string = await IOUtils.readUTF8(this.path);
		this.lastMtime = (await IOUtils.stat(this.path)).lastModified;
		return text.replace(/^\uFEFF/, '');
	}

	private onChange() {
		this.dirty = true;
		if (this.saveTimer !== null) {
			this.win.clearTimeout(this.saveTimer);
		}
		this.saveTimer = this.win.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, SAVE_DELAY_MS);
	}

	saveNow(): Promise<void> {
		if (this.saveTimer !== null) {
			this.win.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		return this.enqueue(() => this.save());
	}

	private async save() {
		if (!this.dirty || this.markdown === null) {
			return;
		}
		let text = this.markdown;
		// Cleared before the write so edits made while it runs schedule another save
		this.dirty = false;
		try {
			let stat = await IOUtils.stat(this.path).catch(() => null);
			if (stat && stat.lastModified !== this.lastMtime && !(await this.confirmOverwrite())) {
				await this.reload();
				return;
			}
			// Write to a dotfile first -- Zotero leaves dotfiles out of the sync ZIP
			let tmpPath = PathUtils.join(PathUtils.parent(this.path), '.' + PathUtils.filename(this.path) + '.tmp');
			await IOUtils.writeUTF8(this.path, text, { tmpPath });
			this.lastMtime = (await IOUtils.stat(this.path)).lastModified;
		}
		catch (e: any) {
			this.dirty = true;
			Zotero.logError(e);
			let message = await this.l10n('md-editor-save-error', {
				name: PathUtils.filename(this.path),
				error: e?.message ?? String(e),
			});
			Services.prompt.alert(this.win, null, message);
		}
	}

	/** Pick up changes made on disk -- by a sync, another app, or a rename -- if we have none */
	checkExternalChange() {
		void this.enqueue(async () => {
			if (this.closed) {
				return;
			}
			let path = await this.item.getFilePathAsync();
			if (path && path !== this.path) {
				this.path = path;
			}
			if (this.dirty || !this.pageWin) {
				return;
			}
			let stat = await IOUtils.stat(this.path).catch(() => null);
			if (stat && stat.lastModified !== this.lastMtime) {
				await this.reload();
			}
		});
	}

	private async reload() {
		let text = await this.read();
		this.dirty = false;
		this.markdown = null;
		if (!this.closed) {
			this.post({ action: 'setValue', markdown: text });
		}
	}

	private async confirmOverwrite(): Promise<boolean> {
		let [title, message, keep, load] = await Promise.all([
			this.l10n('md-editor-conflict-title'),
			this.l10n('md-editor-conflict-message', { name: PathUtils.filename(this.path) }),
			this.l10n('md-editor-conflict-keep'),
			this.l10n('md-editor-conflict-load'),
		]);
		let ps = Services.prompt;
		let flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_0_DEFAULT;
		let button = ps.confirmEx(this.win, title, message, flags, keep, load, null, null, {});
		return button === 0;
	}

	private async saveAsset(name: string, bytes: Uint8Array): Promise<string> {
		let noteName = PathUtils.filename(this.path).replace(/\.[^.]+$/, '');
		let folder = Zotero.File.getValidFileName(noteName + '.assets');
		let dir = PathUtils.join(PathUtils.parent(this.path), folder);
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });

		let fileName = await uniqueFileName(dir, Zotero.File.getValidFileName(name) || 'file');
		await IOUtils.write(PathUtils.join(dir, fileName), bytes, { mode: 'create' });
		return encodeLinkPath(folder) + '/' + encodeLinkPath(fileName);
	}

	/** Resolve an image reference from the note and return it as a data: URL for the page */
	private async loadAsset(src: string): Promise<string | null> {
		let path = resolveLocalPath(src, PathUtils.parent(this.path));
		let ext = path?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
		let type = ext && IMAGE_TYPES[ext];
		if (!path || !type) {
			return null;
		}
		let stat = await IOUtils.stat(path);
		if (stat.type !== 'regular' || stat.size > MAX_IMAGE_BYTES) {
			return null;
		}
		let bytes: Uint8Array = await IOUtils.read(path);
		return `data:${type};base64,${bytes.toBase64()}`;
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(task).catch((e) => Zotero.logError(e));
		return this.queue;
	}

	private l10n(id: string, args?: Record<string, string>): Promise<string> {
		return this.win.document.l10n.formatValue(id, args);
	}

	/** Called from the tab's onClose, just before its container is removed */
	dispose() {
		try {
			let unreported = Components.utils.waiveXrays(this.pageWin)?.mdEditorFlush?.();
			if (typeof unreported === 'string') {
				this.markdown = unreported;
				this.dirty = true;
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		void this.saveNow();
		this.closed = true;
		this.pageWin?.removeEventListener('message', this.onMessage);
		this.pageWin?.removeEventListener('drop', this.onDrop, true);
		this.pageWin = null;
	}
}

/**
 * Turn a link destination from the note into a filesystem path: file:// URLs and absolute paths
 * (what Typora and other editors write when images aren't copied) as they are, anything else
 * relative to the note's directory
 */
function resolveLocalPath(src: string, baseDir: string): string | null {
	if (/^file:/i.test(src)) {
		try {
			return Services.io.newURI(src).QueryInterface(Components.interfaces.nsIFileURL).file.path;
		}
		catch {
			return null;
		}
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) {
		return null;
	}
	let decoded = src.split(/[?#]/)[0];
	try {
		decoded = decodeURI(decoded);
	}
	catch {}
	if (decoded.startsWith('/') || /^[a-z]:[\\/]/i.test(decoded)) {
		return PathUtils.normalize(decoded);
	}
	try {
		return PathUtils.joinRelative(baseDir, decoded.replace(/^\.\//, ''));
	}
	catch {
		return null;
	}
}

/** "20260930121500123" */
function timestamp(): string {
	let d = new Date();
	let pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
		+ `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

async function uniqueFileName(dir: string, name: string): Promise<string> {
	let dot = name.lastIndexOf('.');
	let stem = dot > 0 ? name.slice(0, dot) : name;
	let ext = dot > 0 ? name.slice(dot) : '';
	let candidate = name;
	for (let i = 1; await IOUtils.exists(PathUtils.join(dir, candidate)); i++) {
		candidate = `${stem}-${i}${ext}`;
	}
	return candidate;
}

/** Escape what would end or break a Markdown link destination; leave everything else readable */
function encodeLinkPath(segment: string): string {
	return segment.replace(/[ %()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function vditorLang(): string {
	let locale: string = Zotero.locale || 'en-US';
	if (/^zh-(TW|HK)/i.test(locale)) return 'zh_TW';
	if (/^zh/i.test(locale)) return 'zh_CN';
	let supported = ['de_DE', 'es_ES', 'fr_FR', 'ja_JP', 'ko_KR', 'pt_BR', 'ru_RU', 'sv_SE', 'vi_VN'];
	let lang = supported.find((l) => l.slice(0, 2) === locale.slice(0, 2));
	return lang || 'en_US';
}

// ---------------------------------------------------------------------------------------------
// Creating notes

async function createNote(win: any, parentItem: any | null) {
	let zp = win.ZoteroPane;
	if (!zp.canEdit()) {
		zp.displayCannotEditLibraryMessage();
		return;
	}

	let l10n = win.document.l10n;
	let [title, label, fallback] = await l10n.formatValues([
		{ id: 'md-editor-new-title' },
		{ id: 'md-editor-new-prompt' },
		{ id: 'md-editor-new-default' },
	]);
	let input = { value: fallback };
	if (!Services.prompt.prompt(win, title, label, input, null, {})) {
		return;
	}
	let name = Zotero.File.getValidFileName(input.value.trim().replace(MD_EXTENSION, '')) || fallback;

	let tmpDir = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
	try {
		let tmpFile = PathUtils.join(tmpDir, name + '.md');
		await IOUtils.writeUTF8(tmpFile, `# ${name}\n\n`);
		let options: Record<string, unknown> = {
			file: tmpFile,
			title: name,
			contentType: 'text/markdown',
			charset: 'utf-8',
		};
		if (parentItem) {
			options.libraryID = parentItem.libraryID;
			options.parentItemID = parentItem.id;
		}
		else {
			options.libraryID = zp.getSelectedLibraryID();
			let collection = zp.getSelectedCollection();
			if (collection) {
				options.collections = [collection.id];
			}
		}
		let item = await Zotero.Attachments.importFromFile(options);
		await zp.selectItem(item.id);
		await openEditor(item);
	}
	finally {
		await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
	}
}

// ---------------------------------------------------------------------------------------------
// Menus

function registerMenus() {
	if (!Zotero.MenuManager) {
		return;
	}
	let icon = RESOURCE_ROOT + 'icons/markdown.svg';

	let selectedMarkdown = (ctx: any) =>
		ctx.items?.length === 1 && isMarkdownAttachment(ctx.items[0]) ? ctx.items[0] : null;
	let selectedRegular = (ctx: any) =>
		ctx.items?.length === 1 && ctx.items[0].isRegularItem() ? ctx.items[0] : null;
	let windowOf = (event: any) => event.target.ownerGlobal;

	let itemMenu = Zotero.MenuManager.registerMenu({
		menuID: 'md-editor-item',
		pluginID,
		target: 'main/library/item',
		menus: [
			{
				menuType: 'menuitem',
				l10nID: 'md-editor-menu-edit',
				icon,
				onShowing: (_event: any, ctx: any) => ctx.setVisible(!!selectedMarkdown(ctx)),
				onCommand: (event: any, ctx: any) => void viewWith(windowOf(event), selectedMarkdown(ctx), 'editor'),
			},
			{
				menuType: 'menuitem',
				l10nID: 'md-editor-menu-open-external',
				onShowing: (_event: any, ctx: any) => ctx.setVisible(!!selectedMarkdown(ctx)),
				onCommand: (event: any, ctx: any) => void viewWith(windowOf(event), selectedMarkdown(ctx), 'external'),
			},
			{
				menuType: 'menuitem',
				l10nID: 'md-editor-menu-new-child',
				icon,
				onShowing: (_event: any, ctx: any) => ctx.setVisible(!!selectedRegular(ctx)),
				onCommand: (event: any, ctx: any) => void createNote(windowOf(event), selectedRegular(ctx)),
			},
		],
	});
	if (itemMenu) {
		menuIDs.push(itemMenu);
	}

	let addNoteMenu = Zotero.MenuManager.registerMenu({
		menuID: 'md-editor-add-note',
		pluginID,
		target: 'main/library/addNote',
		menus: [
			{ menuType: 'separator' },
			{
				menuType: 'menuitem',
				l10nID: 'md-editor-menu-new-standalone',
				icon,
				onCommand: (event: any) => void createNote(windowOf(event), null),
			},
			{
				menuType: 'menuitem',
				l10nID: 'md-editor-menu-new-child',
				icon,
				onShowing: (event: any, ctx: any) => {
					let items = windowOf(event).ZoteroPane.getSelectedItems();
					ctx.setEnabled(items.length === 1 && items[0].isRegularItem());
				},
				onCommand: (event: any) => {
					let win = windowOf(event);
					void createNote(win, win.ZoteroPane.getSelectedItems()[0]);
				},
			},
		],
	});
	if (addNoteMenu) {
		menuIDs.push(addNoteMenu);
	}
}
