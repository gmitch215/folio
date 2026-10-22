export const pageBytes = 65536;

// pages that hold different bytes in the unmodified, boot-image and render-image modules
export const checkPages: readonly number[] = [64, 580, 620];

/** 32-bit FNV-1a over the bytes of the given 64 KiB pages, in order. */
export function pagesChecksum(buffer: ArrayBuffer, pages: readonly number[] = checkPages) {
	let hash = 0x811c9dc5;
	for (const page of pages) {
		const view = new Uint8Array(buffer, page * pageBytes, pageBytes);
		for (let index = 0; index < view.length; index++)
			hash = Math.imul(hash ^ view[index]!, 0x01000193);
	}
	return hash >>> 0;
}
