import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const variant = process.argv[2] ?? 'small';
const pages = variant === 'small' ? 16 : 128;
const here = join(root, 'build/research/grain');
const seed = 20261029;

function rng(state: number) {
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function load(path: string, pages: number) {
	const memory = new WebAssembly.Memory({ initial: pages, maximum: 128 });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {
		env: { memory, sin: Math.sin, cos: Math.cos, floor: Math.floor, sqrt: Math.sqrt }
	});
	return { memory, x: instance.exports as Record<string, CallableFunction> };
}

// part 1: generated inputs against the unmodified upstream function in the same module
const { memory, x } = load(join(here, `aes-grain-diff-${variant}.wasm`), pages);
const next = rng(seed);
const grains = [1, 7, 288, 290, 4096];
const cases: { length: number; key: string; iv: string; grain: number; fill: string }[] = [];
const lengths = [16, 32, 48, 288 * 16, 289 * 16, 290 * 16, 291 * 16, 4095 * 16, 4096 * 16];
for (let i = 0; i < 120; i++) {
	const length =
		(i < lengths.length ? lengths[i]! : 1 + Math.floor(next() * 4096)) *
		(i < lengths.length ? 1 : 16);
	cases.push({
		length,
		key: i % 11 === 0 ? 'zero' : i % 13 === 0 ? 'ones' : 'random',
		iv: i % 7 === 0 ? 'zero' : i % 9 === 0 ? 'ones' : 'random',
		grain: grains[i % grains.length]!,
		fill: i % 5 === 0 ? 'zero' : i % 17 === 0 ? 'ones' : 'random'
	});
}
let compared = 0,
	bytes = 0;
for (const c of cases) {
	const view = new Uint8Array(memory.buffer);
	const fill = (pointer: number, size: number, mode: string) => {
		for (let i = 0; i < size; i++)
			view[pointer + i] =
				mode === 'zero' ? 0 : mode === 'ones' ? 255 : Math.floor(next() * 256);
	};
	fill(x.diff_key!(), 16, c.key);
	fill(x.diff_iv!(), 16, c.iv);
	fill(x.diff_cipher!(), 65536, c.fill);
	view.fill(0xa5, x.diff_output!(), x.diff_output!() + 65536);
	const original = x.diff_original!(c.length);
	const variant = x.diff_variant!(c.length, c.grain);
	assert.equal(variant, original, 'return');
	const a = view.subarray(x.diff_scratch!(), x.diff_scratch!() + c.length);
	const b = view.subarray(x.diff_output!(), x.diff_output!() + c.length);
	assert.ok(Buffer.from(a).equals(Buffer.from(b)), `bytes differ: ${JSON.stringify(c)}`);
	// bytes past the length stay untouched
	assert.ok(
		view
			.subarray(x.diff_output!() + c.length, x.diff_output!() + 65536)
			.every((v) => v === 0xa5)
	);
	compared++;
	bytes += c.length;
}

// part 2: the corpus artifact against the grain kernel's entry on the corpus input
const original = load(join(root, 'build/research/corpus/artifacts/aes-cbc-decrypt.wasm'), 128);
original.x.initialize!();
const ret0 = original.x.entry!();
const grain = load(join(here, `aes-grain-${variant}.wasm`), pages);
grain.x.initialize!();
const ret1 = grain.x.entry!();
assert.equal(ret1, ret0);
const o = original.x.corpus_output!(),
	g = grain.x.corpus_output!();
const ob = Buffer.from(new Uint8Array(original.memory.buffer, o, 65536));
const gb = Buffer.from(new Uint8Array(grain.memory.buffer, g, 65536));
assert.ok(ob.equals(gb), 'corpus entry output differs');
// split calls in any order give the same bytes
const split = load(join(here, `aes-grain-${variant}.wasm`), pages);
split.x.initialize!();
for (const first of [3584, 2048, 0, 1024, 512, 3072, 2560, 1536]) split.x.run_range!(first, 512);
assert.ok(Buffer.from(new Uint8Array(split.memory.buffer, g, 65536)).equals(ob), 'split differs');

const summary = {
	seed,
	cases: compared,
	totalBytes: bytes,
	minBytes: Math.min(...cases.map((c) => c.length)),
	maxBytes: Math.max(...cases.map((c) => c.length)),
	corpusReturn: ret0,
	corpusOutputSha: (await import('node:crypto')).createHash('sha256').update(ob).digest('hex'),
	result: 'equal'
};
writeFileSync(
	join(here, `diff-result-${variant}.json`),
	JSON.stringify({ ...summary, cases }, null, 1) + '\n'
);
console.log(JSON.stringify(summary));
