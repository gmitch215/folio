import { PAGE } from './programs.ts';

// a page codec; compress returns a fresh array, decompress fills dst
export interface Codec {
	compress(page: Uint8Array): Uint8Array;
	decompress(packed: Uint8Array, dst: Uint8Array): void;
}

interface Exports {
	memory: WebAssembly.Memory;
	bound(n: number): number;
	compress_at(src: number, n: number, dst: number, cap: number): number;
	decompress_at(src: number, csize: number, dst: number, osize: number): number;
}

// LZ4 block codec over the Wasm build; a page that does not shrink is kept raw and is exactly PAGE bytes
export function lz4Codec(module: WebAssembly.Module): Codec {
	const ex = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
	const cap = ex.bound(PAGE);
	const base = ex.memory.buffer.byteLength;
	ex.memory.grow(Math.ceil((2 * cap + PAGE) / PAGE));
	const inAt = base;
	const outAt = base + cap;
	// memory.grow detaches the old buffer, so views are taken after it
	const view = (at: number, n: number) => new Uint8Array(ex.memory.buffer, at, n);
	return {
		compress(page) {
			view(inAt, PAGE).set(page);
			const n = ex.compress_at(inAt, PAGE, outAt, cap);
			if (n <= 0) throw new Error('lz4 compress failed');
			return n >= PAGE ? page.slice() : view(outAt, n).slice();
		},
		decompress(packed, dst) {
			if (packed.length === PAGE) return void dst.set(packed);
			view(inAt, packed.length).set(packed);
			const n = ex.decompress_at(inAt, packed.length, outAt, PAGE);
			if (n !== PAGE) throw new Error('lz4 decompress failed');
			dst.set(view(outAt, PAGE));
		}
	};
}
