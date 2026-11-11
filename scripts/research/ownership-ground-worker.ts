import { readFileSync } from 'node:fs';
import {
	layoutAlloc,
	OUT,
	relocationMatches,
	STACK_TOP,
	TABLE
} from './ownership-alloc-modules.ts';
import { extremeMatches } from './ownership-extent-modules.ts';

// the same record in 8 pages and in 12 pages with the extra pages poisoned: a different trap, a different byte in
// the first 8 pages or a write to the poison means the module reads the memory size
function wideMatches(bytes: Uint8Array, lengths: number[]): { ok: boolean; why?: string } {
	for (const length of lengths) {
		const runs = [8, 12].map((pages) => {
			const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
			const view = new Uint8Array(memory.buffer);
			const words = new Uint32Array(memory.buffer);
			layoutAlloc(view, words, 3, 0);
			view.fill(0xa5, 8 * 65536);
			words[(TABLE + 4) / 4] = length;
			const instance = new WebAssembly.Instance(
				new WebAssembly.Module(Uint8Array.from(bytes)),
				{
					env: { memory, f: () => {} }
				}
			);
			let trapped = false;
			try {
				(instance.exports.bulk as (t: number, n: number, o: number) => void)(TABLE, 1, OUT);
			} catch {
				trapped = true;
			}
			return { trapped, view };
		});
		const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]];
		if (a.trapped !== b.trapped)
			return { ok: false, why: `wide trap differs at length ${length}` };
		if (a.trapped) continue;
		for (let at = 0; at < 8 * 65536; at++) {
			if (at >= STACK_TOP - 4096 && at < STACK_TOP) continue;
			if (a.view[at] !== b.view[at])
				return { ok: false, why: `wide: byte ${at} at length ${length}` };
		}
		for (let at = 8 * 65536; at < b.view.length; at++)
			if (b.view[at] !== 0xa5)
				return { ok: false, why: `wide: write to the poison at ${at}` };
	}
	return { ok: true };
}

// reads { bytes (base64), cert, seeds, lengths } from stdin and prints the ground-truth verdict as JSON
const input = JSON.parse(readFileSync(0, 'utf8'));
const bytes = new Uint8Array(Buffer.from(input.bytes, 'base64'));
const first = relocationMatches(bytes, input.cert, input.seeds);
const second = first.ok
	? extremeMatches(bytes, input.cert.allocator?.pointerCells, input.lengths)
	: first;
process.stdout.write(JSON.stringify(second.ok ? wideMatches(bytes, input.lengths) : second));
