/**
 * Markdown links to Zotero items and annotations, and the library search behind "@".
 *
 * Links use Zotero's own URI schemes, which work on every synced device (item keys and group
 * IDs are the same everywhere) and from other apps too, since the OS hands zotero:// to Zotero:
 *
 *   zotero://select/library/items/KEY                 show the item in the library
 *   zotero://open/library/items/KEY                   open a file attachment (PDF, EPUB, .md, ...)
 *   zotero://open/library/items/KEY?page=5&annotation=ANNOTKEY
 *   zotero://open/library/items/KEY?page=5&rect=72,500,540,530   text copied from a PDF
 *
 * rect= is ours: for text copied without making an annotation there's no annotation to point
 * at, so the link carries the selection's bounding box (PDF points) on that page. Zotero ignores
 * parameters it doesn't know, so elsewhere the link still opens the right page; in this editor
 * openURL() in main.ts reads it and scrolls to and flashes the passage. EPUB and snapshot
 * selections use Zotero's own cfi= and sel= instead.
 *
 * Group items use groups/<groupID>/items/KEY in place of library/items/KEY.
 */

import type { Insertion, ItemHint } from './types';

declare const Zotero: any;

const MAX_HINTS = 12;

function libraryPath(item: any): string {
	if (item.library.libraryType === 'group') {
		return `groups/${Zotero.Groups.getGroupIDFromLibraryID(item.libraryID)}`;
	}
	return 'library';
}

function zoteroURI(action: 'select' | 'open', item: any, params: Record<string, string | number> = {}): string {
	let query = Object.entries(params)
		// Commas are fine in a query and keep rect=72,500,540,530 readable in the Markdown
		.map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%2C/gi, ',')}`)
		.join('&');
	return `zotero://${action}/${libraryPath(item)}/items/${item.key}` + (query ? '?' + query : '');
}

/** Link text must not end the link early or span lines */
function escapeLabel(text: string): string {
	return text.replace(/\s+/g, ' ').trim().replace(/([\\[\]])/g, '\\$1');
}

function year(item: any): string {
	return item.isRegularItem() ? Zotero.Date.multipartToSQL(item.getField('date', true, true)).slice(0, 4).replace(/^0000$/, '') : '';
}

/**
 * "Smith et al. (2020) Title" for regular items; "<that> · PDF" for their attachments, whose own
 * titles are usually just "PDF" or "Full Text"; the title for anything else
 */
function itemLabel(item: any): string {
	let title = item.getDisplayTitle() || item.attachmentFilename || item.key;
	if (!item.isRegularItem()) {
		let parent = item.parentItem;
		return parent?.isRegularItem() ? `${itemLabel(parent)} · ${title}` : title;
	}
	let creator = item.getField('firstCreator');
	let y = year(item);
	return [creator, y && `(${y})`, title].filter(Boolean).join(' ');
}

/** File attachments open; everything else is shown in the library */
function itemLink(item: any): string {
	let uri = item.isFileAttachment() ? zoteroURI('open', item) : zoteroURI('select', item);
	return `[${escapeLabel(itemLabel(item))}](${uri})`;
}

/** One item as an inline link; several as a list */
export function markdownForItems(items: any[]): Insertion | null {
	items = items.filter((item) => item && !item.isAnnotation());
	if (!items.length) {
		return null;
	}
	if (items.length === 1) {
		return { markdown: itemLink(items[0]), block: false };
	}
	return { markdown: items.map((item) => '- ' + itemLink(item)).join('\n'), block: true };
}

/**
 * The shape the reader puts on the clipboard / drag data as "zotero/annotation"
 * (Zotero.Reader onSetDataTransferAnnotations)
 */
export interface DraggedAnnotation {
	id?: string;
	type?: string;
	text?: string;
	comment?: string;
	pageLabel?: string;
	position?: {
		/** PDF */
		pageIndex?: number;
		rects?: number[][];
		/** EPUB ("FragmentSelector", an EPUB CFI) and snapshots ("CssSelector") */
		type?: string;
		value?: string;
	};
	attachmentItemID?: number;
	image?: string;
}

/**
 * A dragged annotation as a quote with a link back to its place in the PDF/EPUB. Image
 * annotations embed their image, stored beside the note via saveImage.
 */
export async function markdownForAnnotations(
	annotations: DraggedAnnotation[],
	saveImage: (dataURL: string) => Promise<string | null>,
): Promise<Insertion | null> {
	let blocks: string[] = [];
	for (let annotation of annotations) {
		let attachment = annotation.attachmentItemID ? Zotero.Items.get(annotation.attachmentItemID) : null;
		if (!attachment) {
			continue;
		}

		let params: Record<string, string | number> = {};
		let position = annotation.position || {};
		if (typeof position.pageIndex === 'number') {
			params.page = position.pageIndex + 1;
		}
		// Text copied or dragged straight from the page arrives as an unsaved annotation, which
		// has no key to link to, so point at the text itself
		if (annotation.id && Zotero.Items.getByLibraryAndKey(attachment.libraryID, annotation.id)) {
			params.annotation = annotation.id;
		}
		else if (position.type === 'FragmentSelector' && position.value) {
			params.cfi = position.value;
		}
		else if (position.type === 'CssSelector' && position.value) {
			params.sel = position.value;
		}
		else if (position.rects?.length) {
			params.rect = boundingBox(position.rects).map(Math.round).join(',');
		}
		let where = annotation.pageLabel ? `p. ${annotation.pageLabel}` : itemLabel(attachment.parentItem || attachment);
		let link = `[${escapeLabel(where)}](${zoteroURI('open', attachment, params)})`;

		let lines: string[] = [];
		if (annotation.image?.startsWith('data:image/')) {
			let src = await saveImage(annotation.image);
			if (src) {
				lines.push(`![${escapeLabel(where)}](${src})`, '');
			}
		}
		let text = (annotation.text || '').trim();
		if (text) {
			let quoted = text.split(/\r?\n/).map((line) => '> ' + line);
			quoted[quoted.length - 1] += ` (${link})`;
			lines.push(...quoted);
		}
		else {
			lines.push(link);
		}
		let comment = (annotation.comment || '').trim();
		if (comment) {
			lines.push('', comment);
		}
		blocks.push(lines.join('\n'));
	}
	return blocks.length ? { markdown: blocks.join('\n\n'), block: true } : null;
}

function boundingBox(rects: number[][]): number[] {
	return [
		Math.min(...rects.map((r) => r[0])),
		Math.min(...rects.map((r) => r[1])),
		Math.max(...rects.map((r) => r[2])),
		Math.max(...rects.map((r) => r[3])),
	];
}

/**
 * Where a zotero://open link with our rect= parameter points, as a reader location, or null
 * for any other link
 */
export function parseRectLink(url: string): { item: any; location: object } | null {
	let match = url.match(/^zotero:\/\/open\/(?:library|groups\/(\d+))\/items\/([A-Z0-9]+)\?(.*)$/);
	if (!match) {
		return null;
	}
	let [, groupID, key, query] = match;
	let params = Object.fromEntries(query.split('&').map((pair) => {
		let [name, value = ''] = pair.split('=');
		return [name, decodeURIComponent(value)];
	}));
	let page = parseInt(params.page);
	let rect = (params.rect || '').split(',').map(Number);
	if (!page || rect.length !== 4 || rect.some(isNaN)) {
		return null;
	}
	let libraryID = groupID ? Zotero.Groups.getLibraryIDFromGroupID(parseInt(groupID)) : Zotero.Libraries.userLibraryID;
	let item = libraryID && Zotero.Items.getByLibraryAndKey(libraryID, key);
	if (!item) {
		return null;
	}
	return { item, location: { position: { pageIndex: page - 1, rects: [rect] } } };
}

/** Items whose title, creator or year match, across all libraries, regular items first */
export async function searchItems(query: string): Promise<ItemHint[]> {
	query = query.trim();
	if (!query) {
		return [];
	}
	let found: any[] = [];
	for (let library of Zotero.Libraries.getAll()) {
		if (library.libraryType === 'feed') {
			continue;
		}
		let search = new Zotero.Search();
		search.libraryID = library.libraryID;
		search.addCondition('quicksearch-titleCreatorYear', 'contains', query);
		let ids: number[] = await search.search();
		found.push(...await Zotero.Items.getAsync(ids.slice(0, MAX_HINTS * 3)));
	}
	found = found.filter((item) => !item.deleted && !item.isAnnotation() && !item.isNote());
	found.sort((a, b) => Number(b.isRegularItem()) - Number(a.isRegularItem()));
	return found.slice(0, MAX_HINTS).map((item) => ({
		title: item.getDisplayTitle() || item.attachmentFilename || item.key,
		detail: item.isRegularItem()
			? [item.getField('firstCreator'), year(item)].filter(Boolean).join(' · ')
			: (item.attachmentFilename || ''),
		markdown: itemLink(item),
	}));
}
