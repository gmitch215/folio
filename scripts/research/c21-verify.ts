import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import {
	clearOutput,
	instantiate,
	moduleBytes,
	outputOf,
	recordsOf,
	specOf,
	writeRecords
} from './c21-common.ts';
import { buildSpec, layoutOf, specs } from './c21-kernels.ts';

// serial check of the bulk drivers: two runs agree, the output matches an independent reference
const ids = process.argv.slice(2);
const mask = (1n << 64n) - 1n;
const secret = [0x2d358dccaa6c78a5n, 0x8bb84b93962eacc9n, 0x4b33a62ed433d4a3n, 0x4d5a2da51de1aa47n];
const mum = (a: bigint, b: bigint) => {
	const r = a * b;
	return [r & mask, r >> 64n] as const;
};
const mix = (a: bigint, b: bigint) => {
	const [lo, hi] = mum(a, b);
	return lo ^ hi;
};

/** wyhash final version 4.3 with the default secret, written from the algorithm in wyhash.h. */
export function wyhash(data: Uint8Array, seed = 0n): bigint {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const r8 = (at: number) => view.getBigUint64(at, true);
	const r4 = (at: number) => BigInt(view.getUint32(at, true));
	const len = data.length;
	let p = 0;
	seed ^= mix(seed ^ secret[0]!, secret[1]!);
	let a: bigint, b: bigint;
	if (len <= 16) {
		if (len >= 4) {
			a = (r4(0) << 32n) | r4((len >> 3) << 2);
			b = (r4(len - 4) << 32n) | r4(len - 4 - ((len >> 3) << 2));
		} else if (len > 0) {
			a =
				(BigInt(data[0]!) << 16n) |
				(BigInt(data[len >> 1]!) << 8n) |
				BigInt(data[len - 1]!);
			b = 0n;
		} else a = b = 0n;
	} else {
		let i = len;
		if (i >= 48) {
			let see1 = seed,
				see2 = seed;
			do {
				seed = mix(r8(p) ^ secret[1]!, r8(p + 8) ^ seed);
				see1 = mix(r8(p + 16) ^ secret[2]!, r8(p + 24) ^ see1);
				see2 = mix(r8(p + 32) ^ secret[3]!, r8(p + 40) ^ see2);
				p += 48;
				i -= 48;
			} while (i >= 48);
			seed ^= see1 ^ see2;
		}
		while (i > 16) {
			seed = mix(r8(p) ^ secret[1]!, r8(p + 8) ^ seed);
			i -= 16;
			p += 16;
		}
		a = r8(p + i - 16);
		b = r8(p + i - 8);
	}
	a ^= secret[1]!;
	b ^= seed;
	[a, b] = mum(a, b);
	return mix(a ^ secret[0]! ^ BigInt(len), b ^ secret[1]!);
}

const words = (bytes: Uint8Array, at: number, count = 8) =>
	new Uint32Array(bytes.buffer, bytes.byteOffset + at, count);

/** The markdown cases of the spec check: input and the HTML md4c is known to produce. */
export const markdownVectors: [string, string][] = [
	['# Hi\n', '<h1>Hi</h1>\n'],
	['*a* **b**\n', '<p><em>a</em> <strong>b</strong></p>\n'],
	['- a\n- b\n', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n'],
	['`x` & <y>\n', '<p><code>x</code> &amp; <y></p>\n'],
	['[l](http://a.b/c?d=1&e=2)\n', '<p><a href="http://a.b/c?d=1&amp;e=2">l</a></p>\n'],
	['```c\nx\n```\n', '<pre><code class="language-c">x\n</code></pre>\n'],
	['> q\n', '<blockquote>\n<p>q</p>\n</blockquote>\n'],
	[
		'| a | b |\n|---|---|\n| 1 | 2 |\n',
		'<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n'
	]
];

/** The number of nodes yyjson stores for a document: every value, and every object key. */
export const valueCount = (value: unknown): number =>
	Array.isArray(value)
		? 1 + value.reduce((sum: number, item) => sum + valueCount(item), 0)
		: value && typeof value === 'object'
			? 1 + Object.values(value).reduce((sum: number, item) => sum + 1 + valueCount(item), 0)
			: 1;

function check(id: string) {
	const spec = specOf(id);
	buildSpec(spec);
	const n = spec.n;
	const records = recordsOf(spec, n);
	const layout = layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const { memory, exports } = instantiate(spec, layout);
	writeRecords(memory, spec, layout, records);
	const run = () => {
		clearOutput(memory, spec, layout, n);
		const start = performance.now();
		exports.bulk!(layout.table, n, layout.out);
		return {
			ms: performance.now() - start,
			out: Uint8Array.from(outputOf(memory, spec, layout, n))
		};
	};
	const first = run();
	const second = run();
	const times = Array.from({ length: 5 }, () => run().ms).sort((a, b) => a - b);
	assert.deepEqual(first.out, second.out, `${id} output differs between runs`);
	const out = first.out;
	const row = (i: number) => out.subarray(i * spec.slot, (i + 1) * spec.slot);
	const lengths = records.map((r) => r.input.length);
	const facts: Record<string, unknown> = {};
	let compared = 0;
	for (let i = 0; i < n; i++) {
		const bytes = row(i);
		const [first32] = words(bytes, 0, 1);
		const data = (count: number) => bytes.subarray(32, 32 + count);
		const input = records[i]!.input;
		if (id === 'blake2b') {
			assert.equal(first32, 64);
			const expected = createHash('blake2b512').update(input).digest();
			assert.ok(Buffer.from(data(64)).equals(expected), `blake2b record ${i}`);
		} else if (id === 'wyhash') {
			assert.equal(
				new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true),
				wyhash(input)
			);
		} else if (id === 'brotli-compress') {
			assert.ok(first32! > 0);
			const plain = brotliDecompressSync(data(first32!));
			assert.ok(Buffer.from(plain).equals(input), `brotli record ${i}`);
		} else if (id === 'brotli-decompress') {
			assert.equal(first32, 32768);
			assert.ok(
				Buffer.from(data(first32!)).equals(
					specs.find((s) => s.id === 'brotli-compress')!.makeInput!(i)
				)
			);
		} else if (id === 'qoa-encode') {
			assert.equal(first32, 8 + 8 + 2 * 16 + 256 * 8 * 2);
			const file = data(first32!);
			assert.equal(Buffer.from(file.subarray(0, 4)).toString('latin1'), 'qoaf');
			const view = new DataView(file.buffer, file.byteOffset);
			assert.equal(view.getUint32(4), 5120);
			assert.equal(view.getUint8(8), 2);
			assert.equal(view.getUint32(8) & 0xffffff, 44100);
			assert.equal(view.getUint16(12), 5120);
			assert.equal(view.getUint16(14), 8 + 2 * 16 + 256 * 8 * 2);
		} else if (id === 'qoa-decode') {
			assert.equal(first32, 5120 * 2 * 2);
		} else if (id === 'yyjson-read') {
			const count = JSON.parse(Buffer.from(input).toString('utf8'));
			assert.equal(first32, valueCount(count), `yyjson record ${i}`);
			assert.equal(words(bytes, 4, 1)[0], input.length);
		} else if (id === 'md4c-html') {
			assert.ok(
				first32! > 0 && first32! <= spec.slot - 32,
				`md4c record ${i} length ${first32}`
			);
		}
		compared++;
	}
	if (id === 'qoa-decode') {
		// lossy codec: the decoded audio must stay close to the audio that was encoded
		const source = specs.find((s) => s.id === 'qoa-encode')!.makeInput!;
		let signal = 0,
			noise = 0,
			worst = 0;
		for (let i = 0; i < n; i++) {
			const original = new Int16Array(source(i).buffer);
			const decoded = new Int16Array(row(i).slice(32, 32 + 5120 * 4).buffer);
			for (let k = 0; k < original.length; k++) {
				const d = decoded[k]! - original[k]!;
				signal += original[k]! * original[k]!;
				noise += d * d;
				worst = Math.max(worst, Math.abs(d));
			}
		}
		facts.snrDb = 10 * Math.log10(signal / noise);
		facts.maxAbsError = worst;
		assert.ok((facts.snrDb as number) > 20, 'decoded audio is not close to the source');
	}
	if (id === 'wyhash') {
		// every branch of the hash: lengths 0 to 200 cover 0, 1 to 3, 4 to 16, 17 to 47 and 48 and up
		const source = records[0]!.input;
		const inputs = Array.from({ length: 201 }, (_, length) => source.slice(0, length));
		const vector = layoutOf(
			spec,
			inputs.length,
			inputs.map((x) => x.length)
		);
		const small = instantiate(spec, vector);
		writeRecords(
			small.memory,
			spec,
			vector,
			inputs.map((input) => ({ input, aux: new Uint8Array(0) }))
		);
		small.exports.bulk!(vector.table, inputs.length, vector.out);
		const result = outputOf(small.memory, spec, vector, inputs.length);
		inputs.forEach((input, i) => {
			const at = result.byteOffset + i * spec.slot;
			assert.equal(
				new DataView(result.buffer).getBigUint64(at, true),
				wyhash(input),
				`length ${i}`
			);
		});
		facts.lengths = inputs.length;
	}
	if (id === 'md4c-html') {
		const inputs = markdownVectors.map(([text]) => new TextEncoder().encode(text));
		const vector = layoutOf(
			spec,
			inputs.length,
			inputs.map((x) => x.length)
		);
		const small = instantiate(spec, vector);
		writeRecords(
			small.memory,
			spec,
			vector,
			inputs.map((input) => ({ input, aux: new Uint8Array(0) }))
		);
		small.exports.bulk!(vector.table, inputs.length, vector.out);
		const result = outputOf(small.memory, spec, vector, inputs.length);
		markdownVectors.forEach(([, html], i) => {
			const at = i * spec.slot;
			const length = words(result, at, 1)[0]!;
			assert.equal(Buffer.from(result.subarray(at + 32, at + 32 + length)).toString(), html);
		});
		facts.vectors = markdownVectors.length;
	}
	return {
		id,
		n,
		deterministic: true,
		compared,
		recordBytes: [Math.min(...lengths), Math.max(...lengths)],
		serialMs: { median: times[2], min: times[0], max: times[4] },
		outputSha256: createHash('sha256').update(out).digest('hex'),
		imports: WebAssembly.Module.imports(new WebAssembly.Module(moduleBytes(spec))).map(
			(item) => `${item.module}.${item.name}`
		),
		...facts
	};
}

if (import.meta.main) for (const id of ids) console.log(JSON.stringify(check(id)));
