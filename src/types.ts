// Messages between the Zotero-side host (main.ts) and the editor page (editor.ts).
//
// The editor page is an unprivileged resource:// document in a content iframe, like Zotero's own
// note editor. (In a privileged page Firefox sanitizes every innerHTML assignment, which breaks
// Vditor; it's also the safer place to render Markdown that may have been synced from elsewhere.)
// A content iframe's window is its own top, so both sides post to that window and tell the
// directions apart by `to`. Payloads are strings only -- binary data travels as base64 -- so they
// read cleanly through the Xray wrappers the host sees.

export const MESSAGE_KEY = 'zoteroMdEditor';

export type ToPage =
	| { action: 'init'; markdown: string; lang: string; notice: string | null }
	| { action: 'setValue'; markdown: string }
	| { action: 'focus' }
	| { action: 'assetSaved'; requestID: number; link: string | null }
	| { action: 'assetLoaded'; requestID: number; dataURL: string | null };

export type ToHost =
	| { action: 'initialized' }
	/** The document changed; carries the full Markdown so the host never has to ask for it */
	| { action: 'change'; markdown: string }
	/** Cmd/Ctrl+S */
	| { action: 'save' }
	/** Store a pasted or dropped file beside the note; answered with assetSaved */
	| { action: 'saveAsset'; requestID: number; name: string; base64: string }
	/** Read a local image the note links to (relative, absolute or file://); answered with assetLoaded */
	| { action: 'loadAsset'; requestID: number; src: string }
	| { action: 'openURL'; url: string };

export type Envelope =
	| { [MESSAGE_KEY]: 'toPage'; message: ToPage }
	| { [MESSAGE_KEY]: 'toHost'; message: ToHost };
