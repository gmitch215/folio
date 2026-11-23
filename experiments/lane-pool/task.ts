export const CHUNK_BYTES = 65536;
export const LEASE_MS = 8000;

export const taskId = (index: number) => `t${String(index).padStart(4, '0')}`;

/**
 * One independent CPU unit. Fills a chunk from the index with a xorshift generator, then hashes
 * and run-counts it `passes` times, so the cost is linear in `passes` and the result is a pure
 * function of the two arguments.
 */
export function chunk(index: number, passes: number): string {
	const data = new Uint8Array(CHUNK_BYTES);
	let x = Math.imul(index + 1, 0x9e3779b1) >>> 0 || 1;
	for (let i = 0; i < CHUNK_BYTES; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		data[i] = (x >>> 24) & (i & 64 ? 0xff : 0x0f);
	}
	let hash = 0x811c9dc5;
	let runs = 0;
	for (let pass = 0; pass < passes; pass++) {
		let previous = -1;
		for (let i = 0; i < CHUNK_BYTES; i++) {
			const byte = data[i]!;
			hash = Math.imul(hash ^ byte ^ pass, 0x01000193) >>> 0;
			if (byte !== previous) runs++;
			previous = byte;
		}
	}
	return `${index}:${hash.toString(16).padStart(8, '0')}:${runs}`;
}
