import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { predictEnd } from '../../../../src/affine.ts';
import { certifyStream, type StreamCertificate } from '../../../../src/certify.ts';
import { clang, env } from '../../affine-build.ts';
import { groundTruth } from '../../certify-ground.ts';
import { buildModule, MEMORY32, mulberry, sha256, zeroRun } from '../lib.ts';

// every script writes under one directory: ROUND3_OUT, or round3-out in the working directory
export const outDir = resolve(process.env.ROUND3_OUT ?? 'round3-out');
export const work = join(outDir, 'work');
export const modDir = join(outDir, 'modules');
export const specDir = join(outDir, 'specs');
export const resultDir = join(outDir, 'results');

export interface Spec {
	id: string;
	family: string;
	kind: 'c' | 'wat' | 'watmod' | 'wasm';
	src: string;
	opt?: string;
	/** hand model of a module the generator believes is a valid zp fold, for the false-refusal check */
	expect?: { p: number };
	entry?: string;
	note?: string;
	/** pre-built bytes for kind wasm */
	bytes?: Uint8Array;
}

export const writeSpecs = (name: string, specs: Spec[]) => {
	mkdirSync(specDir, { recursive: true });
	writeFileSync(join(specDir, name), JSON.stringify(specs));
};
export const readSpecs = (name: string): Spec[] =>
	JSON.parse(readFileSync(join(specDir, name), 'utf8'));

export const CPRE = `#include <stdint.h>\n#define EXPORT __attribute__((visibility("default")))\n`;

export function buildC(src: string, opt: string, entry = 'update'): Uint8Array {
	const h = sha256(new TextEncoder().encode(src + opt + entry)).slice(0, 20);
	const cfile = join(work, `${h}.c`);
	const out = join(work, `${h}.wasm`);
	mkdirSync(work, { recursive: true });
	writeFileSync(cfile, src);
	execFileSync(
		clang,
		[
			'--target=wasm32',
			opt,
			'-g0',
			'-ffreestanding',
			'-fno-builtin',
			'-nostdlib',
			'-mbulk-memory',
			'-w',
			cfile,
			'-o',
			out,
			`-Wl,--no-entry,--export-memory,--export=${entry}`,
			'-Wl,--initial-memory=2097152,--max-memory=536870912'
		],
		{ env, stdio: 'pipe' }
	);
	return new Uint8Array(readFileSync(out));
}

export const buildWat = (text: string, memory = MEMORY32) =>
	buildModule(`(module ${memory} ${text})`);

export const buildSpec = (spec: Spec): Uint8Array =>
	spec.kind === 'c'
		? buildC(spec.src, spec.opt ?? '-O2', spec.entry ?? 'update')
		: spec.kind === 'wat'
			? buildWat(spec.src)
			: spec.kind === 'watmod'
				? buildModule(spec.src)
				: spec.bytes!;

// #region patterns

const PAT = 70000 + 128;
const patterns: Uint8Array[] = (() => {
	const r = mulberry(12345);
	const rnd = Uint8Array.from({ length: PAT }, () => Math.floor(r() * 256));
	const r2 = mulberry(777);
	const rnd2 = Uint8Array.from({ length: PAT }, () => Math.floor(r2() * 256));
	return [
		rnd,
		new Uint8Array(PAT),
		new Uint8Array(PAT).fill(255),
		Uint8Array.from({ length: PAT }, (_, k) => k & 255),
		rnd2,
		new Uint8Array(PAT).fill(1),
		Uint8Array.from({ length: PAT }, (_, k) => (k % 2 ? 255 : 0))
	];
})();

// #endregion

// #region ground truth

let BASE = 1 << 20;

/** The first input base whose test window clears every exclusion of the certificate. */
export function pickBase(cert?: StreamCertificate): number {
	for (const base of [1 << 20, 0x180000, 0x1c0000, 0x80000, 0x20000, 0x1e0000]) {
		if (!cert || cert.exclusions.every(([from, to]) => base + 76000 <= from || base >= to))
			return base;
	}
	return 1 << 20;
}

interface Inst {
	memory: WebAssembly.Memory;
	call(state: bigint, at: number, len: number): bigint;
	region(at: number, len: number): string;
	raw: Uint8Array;
}

function maker(mod: WebAssembly.Module, cert: StreamCertificate) {
	const { layout, bits } = cert;
	return (kind: number, fillLen = 66000 + 80, offset = 0): Inst => {
		const instance = new WebAssembly.Instance(mod, {});
		const memory = instance.exports.memory as WebAssembly.Memory;
		const need = Math.ceil((BASE + 70000 + 4096 + 64) / 65536);
		if (memory.buffer.byteLength < need * 65536)
			memory.grow(need - memory.buffer.byteLength / 65536);
		new Uint8Array(memory.buffer, BASE + offset, fillLen).set(
			patterns[kind]!.subarray(0, fillLen)
		);
		const fn = instance.exports[cert.entry] as (...a: (number | bigint)[]) => number | bigint;
		return {
			memory,
			raw: new Uint8Array(memory.buffer),
			call(state, at, len) {
				const args: (number | bigint)[] = [0, 0, 0];
				args[layout.state] =
					bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
				args[layout.ptr] = BASE + offset + at;
				args[layout.len] = len;
				return BigInt.asUintN(bits, BigInt(fn(...args)));
			},
			region: (at, len) =>
				Buffer.from(memory.buffer, BASE + offset + at, len).toString('latin1')
		};
	};
}

/** One call at an absolute address on a fresh instance; throws when the entry traps. */
export function placed(
	mod: WebAssembly.Module,
	cert: StreamCertificate,
	at: number,
	input: Uint8Array,
	state = 9n
): { end: bigint; bytes: string } {
	const inst = new WebAssembly.Instance(mod, {});
	const mem = inst.exports.memory as WebAssembly.Memory;
	new Uint8Array(mem.buffer, at, input.length).set(input);
	const args: (number | bigint)[] = [0, 0, 0];
	args[cert.layout.state] = cert.bits === 32 ? Number(state) : state;
	args[cert.layout.ptr] = at;
	args[cert.layout.len] = input.length;
	const f = inst.exports[cert.entry] as (...a: (number | bigint)[]) => number | bigint;
	const end = BigInt.asUintN(cert.bits, BigInt(f(...args)));
	return { end, bytes: Buffer.from(mem.buffer, at, input.length).toString('latin1') };
}

/** Pointers near the start and the end of memory that clear every exclusion. */
export function pointerSpots(mod: WebAssembly.Module, cert: StreamCertificate, len: number) {
	const memBytes = (new WebAssembly.Instance(mod, {}).exports.memory as WebAssembly.Memory).buffer
		.byteLength;
	const spots = [
		0,
		1,
		2,
		3,
		4,
		7,
		8,
		15,
		16,
		31,
		32,
		255,
		256,
		memBytes - len,
		memBytes - len - 1,
		memBytes - len - 3,
		memBytes - 64
	];
	return {
		memBytes,
		spots: spots.filter(
			(at) =>
				at >= 0 &&
				at + len <= memBytes &&
				cert.exclusions.every(([from, to]) => at + len <= from || at >= to)
		)
	};
}

const LENS = [
	1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 257, 1023, 4095, 4096, 4097,
	65535, 65536, 65537
];

const statesFor = (cert: StreamCertificate, r: () => number): bigint[] => {
	const bits = BigInt(cert.bits);
	const m = (1n << bits) - 1n;
	const out = new Set<bigint>([
		0n,
		1n,
		0x80000000n & m,
		0xffffffffn & m,
		0xdeadbeefcafef00dn & m
	]);
	if (cert.ring === 'zp' && cert.model.modulus) {
		const p = cert.model.modulus;
		const ds = [0n, 1n, p - 1n, p, p + 1n, 65535n, 65520n, 12345n].map((d) => d & 0xffffn);
		let at = 0;
		for (const lo of ds)
			for (const hi of ds) if (at++ % 3 === 0 || lo === hi) out.add((hi << 16n) | lo);
	}
	for (let k = 0; k < 4; k++)
		out.add(
			((BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32))) & m
		);
	return [...out];
};

/** Strengthened ground truth. Returns the first disagreement or an empty string. */
export function ground2(bytes: Uint8Array, cert: StreamCertificate, heavy = false): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	BASE = pickBase(cert);
	const makeFull = maker(mod, cert);
	let make = makeFull;
	const r = mulberry(99);
	const bits = BigInt(cert.bits);
	const m = (1n << bits) - 1n;
	const out = !!cert.output;
	const step = cert.output?.step;
	const allStates = statesFor(cert, r);
	const initInit = new Set<number>();
	for (const w of cert.initialization)
		for (let k = 0; k < w.hex.length / 2; k++) initInit.add(w.address + k);
	const sameOutside = (a: Inst, b: Inst, len: number, at = 0, lo = 0, hi = a.raw.length) => {
		// bytes outside [at, at+len) must match the reference instance that did not run
		const s = BASE + at;
		const x = Buffer.from(a.memory.buffer);
		const y = Buffer.from(b.memory.buffer);
		for (const [from, to] of [
			[lo, s],
			[s + len, hi]
		] as const) {
			if (to <= from) continue;
			const xs = x.subarray(from, to);
			const ys = y.subarray(from, to);
			if (Buffer.compare(xs, ys) === 0) continue;
			for (let k = 0; k < xs.length; k++)
				if (xs[k] !== ys[k] && !initInit.has(from + k)) return false;
		}
		return true;
	};
	const lens = heavy ? LENS : LENS.filter((l) => l <= 257 || [1023, 4097, 65537].includes(l));
	for (const len of lens) {
		make = (kind, fill = Math.min(66080, len + 80), off = 0) => makeFull(kind, fill, off);
		const special = [1, 2, 3, 17, 33].includes(len);
		const kinds = len > 257 ? (heavy ? [0, 4] : [0]) : special ? [0, 1, 2, 4] : [0, 2, 4];
		for (const kind of kinds) {
			const states =
				len > 257
					? allStates.slice(0, heavy ? 5 : 3).concat(allStates.slice(heavy ? -3 : -2))
					: special
						? allStates.slice(0, heavy ? 80 : 40)
						: allStates.slice(0, 5).concat(allStates.slice(-4));
			for (const s of states) {
				const tag = `len ${len} state ${s} pattern ${kind}`;
				const ref = make(kind);
				const untouched = make(kind);
				let end: bigint;
				try {
					end = ref.call(s, 0, len);
				} catch {
					return `trap ${tag}`;
				}
				const whole = ref.region(0, len);
				if (!sameOutside(ref, untouched, len)) return `writes outside the input ${tag}`;
				if (!out && whole !== untouched.region(0, len))
					return `input modified without output ${tag}`;
				// second call on the same instance after restoring the input
				{
					const again = make(kind);
					again.call(s, 0, len);
					new Uint8Array(again.memory.buffer, BASE, len).set(
						patterns[kind]!.subarray(0, len)
					);
					const e2 = again.call(s, 0, len);
					if (e2 !== end || again.region(0, len) !== whole)
						return `second call differs ${tag}`;
				}
				// chain at cuts
				const cuts = new Set([
					1,
					Math.floor(len / 3),
					Math.floor(len / 2),
					len - 1,
					1 + Math.floor(r() * Math.max(1, len - 1))
				]);
				for (const cut of cuts) {
					if (cut < 1 || cut >= len) continue;
					const c = make(kind);
					const mid = c.call(s, 0, cut);
					const e3 = c.call(mid, cut, len - cut);
					if (e3 !== end) return `chain end ${tag} cut ${cut}`;
					if (c.region(0, len) !== whole) return `chain bytes ${tag} cut ${cut}`;
				}
				// model chain over random splits, each chunk from state zero
				if (len >= 2) {
					for (const k of [2, 3, 5, 7]) {
						const edges = new Set<number>([0, len]);
						while (edges.size < Math.min(k + 1, len + 1))
							edges.add(Math.floor(r() * (len + 1)));
						const e = [...edges].sort((a, b) => a - b);
						let comb = s & m;
						for (let j = 0; j + 1 < e.length; j++) {
							const from = e[j]!;
							const to = e[j + 1]!;
							if (to === from) continue;
							const chunk = make(kind).call(0n, from, to - from);
							comb = predictEnd(cert.model, comb, to - from, chunk);
						}
						if (comb !== end)
							return `model chain ${tag} split ${e.join(',')} got ${comb} want ${end}`;
					}
				}
				if (out && len >= 2) {
					// the bytes of one chunk depend only on the bytes before it and the state: run chunks in reverse
					for (const width of [2, 3, 5]) {
						const edges: number[] = [0];
						for (let k = 1; k <= width; k++) edges.push(Math.floor((k * len) / width));
						const starts: bigint[] = [s & m];
						if (step !== undefined) {
							for (let k = 0; k < width; k++) {
								const l = edges[k + 1]! - edges[k]!;
								starts.push(
									l > 0
										? predictEnd(cert.model, starts[k]!, l, zeroRun(cert, l))
										: starts[k]!
								);
							}
						} else {
							const ser = make(kind);
							for (let k = 0; k < width; k++)
								starts.push(
									edges[k + 1]! > edges[k]!
										? ser.call(starts[k]!, edges[k]!, edges[k + 1]! - edges[k]!)
										: starts[k]!
								);
						}
						const rev = make(kind);
						for (let k = width - 1; k >= 0; k--)
							if (edges[k + 1]! > edges[k]!) {
								const got = rev.call(
									starts[k]!,
									edges[k]!,
									edges[k + 1]! - edges[k]!
								);
								if (got !== starts[k + 1])
									return `reverse chunk end ${tag} width ${width} chunk ${k}`;
							}
						if (rev.region(0, len) !== whole)
							return `reverse chunks bytes ${tag} width ${width}`;
						if (starts[width] !== end)
							return `reverse chunk start states ${tag} width ${width}`;
					}
					// prefix property and perturbation
					if (len >= 3) {
						const longer = make(kind, 66000 + 80);
						const n2 = Math.min(len + 5, 70000);
						longer.call(s, 0, n2);
						if (longer.region(0, len) !== whole)
							return `prefix of a longer call differs ${tag}`;
						const j = 1 + Math.floor(r() * (len - 1));
						const pert = make(kind);
						pert.raw[BASE + j]! ^= 0x5a;
						pert.call(s, 0, len);
						if (pert.region(0, j) !== whole.slice(0, j))
							return `output byte before ${j} depends on a later byte ${tag}`;
						if (step !== undefined) {
							const want = whole.slice(0, j) + whole.slice(j + 1);
							const got = pert.region(0, j) + pert.region(j + 1, len - j - 1);
							if (got !== want)
								return `step claims states ignore bytes but byte ${j} changes another ${tag}`;
						}
					}
				}
			}
		}
	}
	make = (kind, fill = 5000, off = 0) => makeFull(kind, fill, off);
	// pointers at odd offsets
	for (const len of [1, 2, 17, 100, 4097]) {
		for (const off of [1, 3, 5, 7, 13]) {
			const mv = make(0, 66000 + 80, 0);
			// same bytes at a shifted address
			const dst = 70000 + off;
			new Uint8Array(mv.memory.buffer, BASE + dst, len).set(patterns[0]!.subarray(0, len));
			const refr = make(0);
			const a = refr.call(7n, 0, len);
			const b = mv.call(7n, dst, len);
			if (a !== b) return `pointer shift ${off} len ${len}`;
			if (out && refr.region(0, len) !== mv.region(dst, len))
				return `pointer shift bytes ${off} len ${len}`;
		}
	}
	// inputs placed against the exclusions
	for (const [from, to] of cert.exclusions) {
		for (const len of [1, 16, 17, 100]) {
			for (const at of [from - len, to]) {
				if (at < 0 || at + len > 2 * 1048576) continue;
				if (at + len < BASE || at > BASE + 140000) {
					const refr = make(0);
					let got: { end: bigint; bytes: string };
					try {
						got = placed(mod, cert, at, patterns[0]!.subarray(0, len));
					} catch {
						return `trap beside exclusion ${from}-${to} at ${at} len ${len}`;
					}
					const want = refr.call(9n, 0, len);
					if (got.end !== want)
						return `exclusion boundary ${from}-${to} at ${at} len ${len}`;
					if (out && got.bytes !== refr.region(0, len))
						return `exclusion boundary bytes ${from}-${to} at ${at} len ${len}`;
				}
			}
		}
	}
	// pointers at the start and the end of memory, and low odd ones, wherever the guard allows them
	for (const len of [1, 2, 3, 17, 100]) {
		const refr = makeFull(0, 200);
		const want = refr.call(9n, 0, len);
		const wantBytes = refr.region(0, len);
		const { memBytes, spots } = pointerSpots(mod, cert, len);
		for (const at of spots) {
			let got: { end: bigint; bytes: string };
			try {
				got = placed(mod, cert, at, patterns[0]!.subarray(0, len));
			} catch (e) {
				return `trap at pointer ${at} len ${len} (memory ${memBytes}): ${String(e).slice(0, 60)}`;
			}
			if (got.end !== want) return `pointer ${at} len ${len} end ${got.end} want ${want}`;
			if (out && got.bytes !== wantBytes) return `pointer ${at} len ${len} bytes differ`;
		}
	}
	return '';
}

// #endregion

// #region composes check for refused modules

/** Cheap check that the entry is a left fold: chained calls agree with one call. Returns '' when it is. */
export function composes(bytes: Uint8Array, entry = 'update'): string {
	let mod: WebAssembly.Module;
	try {
		mod = new WebAssembly.Module(Uint8Array.from(bytes));
	} catch {
		return 'invalid';
	}
	const r = mulberry(5);
	const imports: WebAssembly.Imports = {};
	for (const i of WebAssembly.Module.imports(mod)) {
		imports[i.module] ??= {};
		(imports[i.module] as any)[i.name] = i.kind === 'function' ? () => 0 : undefined;
	}
	let fillLen = 66080;
	const fresh = (kind: number) => {
		const inst = new WebAssembly.Instance(mod, imports);
		const memory = inst.exports.memory as WebAssembly.Memory;
		const need = Math.ceil((BASE + 70000 + 64) / 65536);
		if (memory.buffer.byteLength < need * 65536)
			memory.grow(need - memory.buffer.byteLength / 65536);
		new Uint8Array(memory.buffer, BASE, fillLen).set(patterns[kind]!.subarray(0, fillLen));
		const fn = inst.exports[entry] as Function;
		return {
			memory,
			call: (s: number, at: number, len: number): number | string => {
				try {
					return (fn(s | 0, BASE + at, len) as number) >>> 0;
				} catch {
					return 'trap';
				}
			}
		};
	};
	const states = [1, 0xffffffff, 0xdeadbeef, 0xfff1ffff, 0xffff0000];
	for (const len of [1, 2, 3, 17, 33, 257, 4097, 65537]) {
		fillLen = Math.min(66080, len + 80);
		for (const kind of [0, 2]) {
			for (const s of states) {
				const whole = fresh(kind);
				const e = whole.call(s, 0, len);
				const wr = Buffer.from(whole.memory.buffer, BASE, len).toString('latin1');
				for (const cut of [1, Math.floor(len / 2), len - 1, 1 + Math.floor(r() * len)]) {
					if (cut < 1 || cut >= len) continue;
					const c = fresh(kind);
					const mid = c.call(s, 0, cut);
					const e2 = typeof mid === 'string' ? mid : c.call(mid, cut, len - cut);
					if (e2 !== e) return `len ${len} cut ${cut} state ${s >>> 0} kind ${kind}`;
					if (Buffer.from(c.memory.buffer, BASE, len).toString('latin1') !== wr)
						return `bytes len ${len} cut ${cut}`;
				}
			}
		}
	}
	return '';
}

// #endregion

export interface Row {
	id: string;
	family: string;
	sha256: string;
	opt?: string;
	verdict:
		| 'accepted-correct'
		| 'ACCEPTED-WRONG'
		| 'refused'
		| 'refused-valid'
		| 'build-error'
		| 'harness-error';
	ring?: string;
	output?: boolean;
	modulus?: string;
	reason?: string;
	ground?: string;
	ground2?: string;
	composes?: string;
	note?: string;
	ms?: number;
}

// a hand certificate for the zp fold a refused module was meant to be
const handCertificate = (entry: string, p: bigint) =>
	({
		kind: 'certificate',
		entry,
		bits: 32,
		ring: 'zp',
		layout: { entry: 'update', state: 0, ptr: 1, len: 2, bits: 32 },
		model: {
			kind: 'model',
			ring: 'zp',
			bits: 32,
			align: 1,
			layout: { entry: 'update', state: 0, ptr: 1, len: 2, bits: 32 },
			operator: [1n, 0n, 1n, 1n],
			modulus: p,
			digits: 2,
			calls: 0,
			checks: []
		},
		exclusions: [],
		initialization: []
	}) as unknown as StreamCertificate;

export function evaluate(spec: Spec, heavy = false, progress?: (r: Row) => void): Row {
	const t0 = Date.now();
	const row: Row = {
		id: spec.id,
		family: spec.family,
		sha256: '',
		opt: spec.opt,
		verdict: 'refused',
		note: spec.note
	};
	let bytes: Uint8Array;
	try {
		bytes = buildSpec(spec);
	} catch (e) {
		row.verdict = 'build-error';
		row.reason = String((e as Error).message)
			.split('\n')
			.slice(0, 3)
			.join(' | ')
			.slice(0, 300);
		return row;
	}
	row.sha256 = sha256(bytes);
	mkdirSync(modDir, { recursive: true });
	writeFileSync(join(modDir, `${row.sha256.slice(0, 16)}.wasm`), bytes);
	try {
		const cert = certifyStream(bytes, spec.entry ?? 'update');
		progress?.(
			cert.kind === 'refusal'
				? {
						...row,
						verdict: 'refused',
						reason: cert.reason.slice(0, 300),
						composes: 'hang: execution did not finish before the time limit'
					}
				: {
						...row,
						verdict: 'harness-error',
						ring: cert.ring,
						output: !!cert.output,
						reason: 'accepted, but the ground truth did not finish before the time limit'
					}
		);
		if (cert.kind === 'refusal') {
			row.verdict = 'refused';
			row.reason = cert.reason.slice(0, 300);
			row.composes = composes(bytes, spec.entry ?? 'update');
			if (spec.expect && !row.composes) {
				const fake = handCertificate(spec.entry ?? 'update', BigInt(spec.expect.p));
				row.ground = groundTruth(bytes, fake, [1, 2, 3, 17, 257, 4097, 65537]);
				if (!row.ground) row.verdict = 'refused-valid';
			}
			return row;
		}
		row.ring = cert.ring;
		row.output = !!cert.output;
		row.modulus = cert.model.modulus?.toString();
		row.ground = groundTruth(bytes, cert, [1, 2, 17, 257, 4097], pickBase(cert));
		// the standard check counts the documented initialization writes as writes outside the input
		if (cert.initialization.length && /writes outside the input/.test(row.ground)) {
			row.note = `${row.note ?? ''} [initialization write ignored: ${row.ground}]`;
			row.ground = '';
		}
		row.ground2 = ground2(bytes, cert, heavy);
		BASE = 1 << 20;
		row.verdict = row.ground || row.ground2 ? 'ACCEPTED-WRONG' : 'accepted-correct';
	} catch (e) {
		row.verdict = 'harness-error';
		row.reason = String((e as Error).message).slice(0, 300);
	}
	row.ms = Date.now() - t0;
	return row;
}
