declare module '*.css';

// Base64 helpers on Uint8Array (Firefox 133+, so every Zotero this plugin supports)
interface Uint8Array {
	toBase64(): string;
}
interface Uint8ArrayConstructor {
	fromBase64(base64: string): Uint8Array;
}
