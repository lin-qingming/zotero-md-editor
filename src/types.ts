// Messages between the Zotero-side host (main.ts) and the editor page (editor.ts).
//
// The editor page is an unprivileged resource:// document in a content iframe, like Zotero's own
// note editor. (In a privileged page Firefox sanitizes every innerHTML assignment, which breaks
// Vditor; it's also the safer place to render Markdown that may have been synced from elsewhere.)
// A content iframe's window is its own top, so both sides post to that window and tell the
// directions apart by the envelope key. Payloads are strings, numbers and plain objects only --
// binary data travels as base64 -- so they read cleanly through the Xray wrappers the host sees.

export const MESSAGE_KEY = 'zoteroMdEditor';

/** A search result for the "@" autocomplete */
export interface ItemHint {
	title: string;
	/** Secondary text, e.g. "Smith · 2020" or "PDF" */
	detail: string;
	/** What to insert: a Markdown link to the item */
	markdown: string;
}

/** Markdown to insert, and whether it needs a paragraph of its own (a list or quote) */
export interface Insertion {
	markdown: string;
	block: boolean;
}

export interface PageStrings {
	insertItem: string;
}

export type ToPage =
	| { action: 'init'; markdown: string; lang: string; notice: string | null; strings: PageStrings }
	| { action: 'setValue'; markdown: string }
	| { action: 'focus' }
	/**
	 * Insert Markdown at the cursor, or where something was dropped (client coordinates);
	 * `block` content gets its own paragraph
	 */
	| { action: 'insert'; markdown: string; block: boolean; point: { x: number; y: number } | null }
	/** Answer to a request (see RequestToHost), matched by requestID */
	| { action: 'reply'; requestID: number; value: unknown };

/** Messages the host answers with a reply */
export type RequestToHost =
	/** Store a pasted or dropped file beside the note; replies with the relative link, or null */
	| { action: 'saveAsset'; requestID: number; name: string; base64: string }
	/** Read a local image the note links to (relative, absolute or file://); replies with a data: URL, or null */
	| { action: 'loadAsset'; requestID: number; src: string }
	/** Search the libraries for "@" autocomplete; replies with ItemHint[] */
	| { action: 'searchItems'; requestID: number; query: string }
	/** Show Zotero's item picker; replies with an Insertion for the chosen items, or null */
	| { action: 'pickItems'; requestID: number }
	/**
	 * Text or annotations copied in Zotero's reader, as the "zotero/annotation" clipboard JSON;
	 * replies with an Insertion quoting them with links back, or null
	 */
	| { action: 'annotationsToMarkdown'; requestID: number; json: string };

export type ToHost =
	| RequestToHost
	| { action: 'initialized' }
	/** The document changed; carries the full Markdown so the host never has to ask for it */
	| { action: 'change'; markdown: string }
	/** Cmd/Ctrl+S */
	| { action: 'save' }
	/** Cmd/Ctrl+click on a link: zotero://, http(s):// or mailto: */
	| { action: 'openURL'; url: string };

export type Envelope =
	| { [MESSAGE_KEY]: 'toPage'; message: ToPage }
	| { [MESSAGE_KEY]: 'toHost'; message: ToHost };
