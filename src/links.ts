/**
 * Markdown links to Zotero items and annotations, and the library search behind "@".
 *
 * Links use Zotero's own URI schemes, which work on every synced device (item keys and group
 * IDs are the same everywhere) and from other apps too, since the OS hands zotero:// to Zotero:
 *
 *   zotero://select/library/items/KEY                 show the item in the library
 *   zotero://open/library/items/KEY                   open a file attachment (PDF, EPUB, .md, ...)
 *   zotero://open/library/items/KEY?page=5&annotation=ANNOTKEY
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
		.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
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
	position?: { pageIndex?: number };
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
		let pageIndex = annotation.position?.pageIndex;
		if (typeof pageIndex === 'number') {
			params.page = pageIndex + 1;
		}
		// Text dragged straight from the page arrives as an unsaved annotation, which has no key
		// to link to; the page number still gets you there
		if (annotation.id && Zotero.Items.getByLibraryAndKey(attachment.libraryID, annotation.id)) {
			params.annotation = annotation.id;
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
