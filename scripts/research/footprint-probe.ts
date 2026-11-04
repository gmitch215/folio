import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { hostMath, moduleBytes, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, outDir, specs } from './c21-kernels.ts';

// usage: footprint-probe.ts OUTPUT.json ; serial footprint of every built bulk driver
const target = process.argv[2];
if (!target) throw new Error('usage: footprint-probe.ts OUTPUT.json');
if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);

// pass or fail is the slice pool census outcome of each driver
const N = 6;
const EXTRA = 8;
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

const census: Record<string, 'pass' | 'fail'> = {};
for (const id of [
	'aes-cbc-decrypt-shared',
	'jsmn-parse-shared',
	'kissfft-real-shared',
	'miniz-compress',
	'miniz-decompress',
	'qoi-decode',
	'qoi-decode-64',
	'qoi-encode',
	'qoi-encode-64',
	'sha256-shared'
])
	census[id] = 'fail';
for (const id of [
	'aes-cbc-decrypt',
	'aes-cbc-encrypt',
	'aes-cbc-encrypt-slot',
	'aes-ctr',
	'jsmn-parse',
	'jsmn-parse-slot',
	'kissfft-complex',
	'kissfft-real',
	'lz4-compress',
	'lz4-decompress',
	'm6502',
	'md5',
	'md5-slot',
	'miniz-adler32',
	'miniz-crc32',
	'sha1',
	'sha256',
	'xxhash3',
	'xxhash32',
	'xxhash64'
])
	census[id] = 'pass';

function relocated(bytes: Uint8Array, top: number): Uint8Array<ArrayBuffer> | undefined {
	const mod = binaryen.readBinary(bytes);
	mod.setFeatures(binaryen.Features.All & ~compact);
	const count = mod.getNumGlobals();
	let found = false;
	for (let i = 0; i < count; i++) {
		const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(i));
		if (info.name === '__stack_pointer') {
			mod.removeGlobal('__stack_pointer');
			mod.addGlobal('__stack_pointer', binaryen.i32, true, mod.i32.const(top));
			found = true;
			break;
		}
	}
	const out = found ? Uint8Array.from(mod.emitBinary()) : undefined;
	mod.dispose();
	return out;
}

const random = (seed: number) => {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s & 255;
	};
};

const hash = (view: Uint8Array) => createHash('sha256').update(view).digest('hex').slice(0, 16);

const rows: object[] = [];
for (const spec of specs) {
	if (!existsSync(`${outDir}/${spec.id}.wasm`)) continue;
	try {
		const n = Math.min(N, spec.n);
		const records = recordsOf(spec, n);
		const layout = layoutOf(
			spec,
			n,
			records.map((r) => r.input.length)
		);
		const pages = layout.pages + EXTRA;
		const bytes = moduleBytes(spec);
		const shifted = relocated(bytes, pages * 65536);
		const run = (module: Uint8Array<ArrayBuffer>) => {
			const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
			const exports = new WebAssembly.Instance(new WebAssembly.Module(module), {
				env: { memory, ...hostMath() }
			}).exports as Record<string, Function>;
			if (spec.config)
				exports.setup!(layout.config, spec.config.perRecord ? n : 1, spec.config.nfft);
			writeRecords(memory, spec, layout, records);
			const view = new Uint8Array(memory.buffer);
			return { view, baseline: view.slice(), exports };
		};
		const one = (ctx: ReturnType<typeof run>, i: number) => {
			ctx.exports.bulk!(layout.table + 16 * i, 1, layout.out + spec.slot * i);
			return hash(
				ctx.view.subarray(layout.out + spec.slot * i, layout.out + spec.slot * (i + 1))
			);
		};
		const diff = (ctx: ReturnType<typeof run>) => {
			const set = new Set<number>();
			const { view, baseline } = ctx;
			for (let at = 0; at < view.length; at++) if (view[at] !== baseline[at]) set.add(at);
			return set;
		};
		const own = (i: number) => (at: number) =>
			(at >= layout.out + spec.slot * i && at < layout.out + spec.slot * (i + 1)) ||
			(spec.arena > 0 &&
				at >= layout.arena + i * spec.arena &&
				at < layout.arena + (i + 1) * spec.arena) ||
			(!!spec.config &&
				spec.config.perRecord &&
				at >= layout.config + i * spec.config.stride &&
				at < layout.config + (i + 1) * spec.config.stride);
		const base = run(bytes);
		const alt = shifted ? run(shifted) : undefined;
		const fresh: string[] = [];
		const freshShifted: string[] = [];
		const writes: Set<number>[] = [];
		for (let i = 0; i < n; i++) {
			base.view.set(base.baseline);
			fresh.push(one(base, i));
			const w0 = diff(base);
			if (alt) {
				alt.view.set(alt.baseline);
				freshShifted.push(one(alt, i));
				const w1 = diff(alt);
				for (const at of [...w0]) if (!w1.has(at)) w0.delete(at);
			}
			const mine = own(i);
			for (const at of [...w0]) if (mine(at)) w0.delete(at);
			writes.push(w0);
		}
		const count = new Map<number, number>();
		for (const set of writes) for (const at of set) count.set(at, (count.get(at) ?? 0) + 1);
		const shared = [...count].filter(([, c]) => c > 1).map(([at]) => at);
		const sharedSet = new Set(shared);
		const region: Record<string, number> = {};
		const classify = (at: number) => {
			if (at >= layout.arena && spec.arena > 0 && at < layout.data) return 'arena';
			if (spec.config && at >= layout.config && at < layout.aux) return 'config';
			if (at < layout.table) return 'static-zone';
			if (at >= layout.data) return 'input-data';
			return 'other';
		};
		for (const at of shared) region[classify(at)] = (region[classify(at)] ?? 0) + 1;
		const carried = (order: number[]) => {
			base.view.set(base.baseline);
			const result: string[] = [];
			for (const i of order) result[i] = one(base, i);
			return result;
		};
		const forward = carried([...Array(n).keys()]);
		const backward = carried([...Array(n).keys()].reverse());
		const same = (a: string[], b: string[]) => a.every((v, i) => v === b[i]);
		// poison the shared written bytes with random values and compare with the fresh output
		let poisonChanged = 0;
		for (let seed = 1; seed <= 2; seed++) {
			const next = random(seed * 7919);
			for (let i = 0; i < n; i++) {
				base.view.set(base.baseline);
				for (const at of shared) base.view[at] = next();
				if (one(base, i) !== fresh[i]) poisonChanged++;
			}
		}
		rows.push({
			id: spec.id,
			label: census[spec.id] ?? 'unlabeled',
			stackShifted: !!shifted,
			records: n,
			sharedWriteBytes: shared.length,
			sharedRegions: region,
			sharedFirst: shared.slice(0, 8),
			carriedEqualsFresh: same(forward, fresh),
			permutedEqualsFresh: same(backward, fresh),
			stackShiftOutputEqual: shifted ? same(freshShifted, fresh) : null,
			poisonChangedOutputs: poisonChanged,
			poisonTrials: 2 * n,
			writeSetBytes: writes.map((w) => w.size),
			sharedOutsideOwn: sharedSet.size
		});
	} catch (error) {
		rows.push({ id: spec.id, error: String(error).slice(0, 200) });
	}
}
writeFileSync(
	target,
	JSON.stringify(
		{
			kind: 'serial-footprint-probe',
			node: process.version,
			records: N,
			limitations: [
				'write sets are byte differences against a baseline: same-value writes and reads are invisible',
				'stack writes are separated by relocating __stack_pointer to the memory tail; modules without that global are not shifted',
				'poisoning overwrites the union of shared written bytes with pseudo-random values, two seeds',
				'records are the first six of each driver, one input pattern'
			],
			rows
		},
		null,
		2
	) + '\n'
);
console.log(
	JSON.stringify(
		rows.map((r: any) => [
			r.id,
			r.label,
			r.sharedWriteBytes,
			r.carriedEqualsFresh,
			r.permutedEqualsFresh,
			r.stackShiftOutputEqual,
			r.poisonChangedOutputs,
			r.error
		])
	)
);
