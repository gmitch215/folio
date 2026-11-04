import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { predictEnd } from '../../../src/affine.ts';
import {
	certifyStream,
	type CertificateRefusal,
	type StreamCertificate
} from '../../../src/certify.ts';

export const PAGE = 65536;
export const BASE = 1 << 20;
export const MAXLEN = 1 << 20;
export const PTR_OFFS = [0, 1, 2, 3, 5, 7];
export const LENS_FULL = [
	1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1000, 1023, 1024,
	1025, 4095, 4096, 4097, 65535, 65536, 65537, 100000, 262143, 262144, 1048576
];
export const LENS_LIGHT = [1, 2, 3, 7, 16, 17, 64, 1000, 4096, 65537];
const STATES32 = [0n, 1n, 0x80000000n, 0xffffffffn, 0xdeadbeefn];
const STATES64 = [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn, 0xdeadbeefcafef00dn];

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// the work directory is the first argument; every script writes under it
export const workDir = (arg: string | undefined) => resolve(arg ?? 'adversary-out');

export function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...walk(path));
		else if (name.endsWith('.wasm')) out.push(path);
	}
	return out;
}

export function mulberry(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function patternBytes(kind: 'rand' | 'zero' | 'ff' | 'asc', seed: number): Uint8Array {
	const out = new Uint8Array(MAXLEN + 64);
	if (kind === 'zero') return out;
	if (kind === 'ff') return out.fill(0xff);
	if (kind === 'asc') {
		for (let i = 0; i < out.length; i++) out[i] = i & 255;
		return out;
	}
	const r = mulberry(seed);
	for (let i = 0; i < out.length; i++) out[i] = Math.floor(r() * 256);
	return out;
}

// parses a whole WAT module; throws when binaryen or the engine rejects it
export function buildModule(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	try {
		module.setFeatures(binaryen.Features.All & ~(binaryen.Features as any).CompactImports);
		if (!module.validate()) throw new Error('binaryen validation failed');
		const bytes = Uint8Array.from(module.emitBinary());
		new WebAssembly.Module(bytes);
		return bytes;
	} finally {
		module.dispose();
	}
}

// the 32 page memory of the third round modules and the reviewer's fuzzers
export const MEMORY32 = '(memory (export "memory") 32 512)';

// module body with the default 40 page memory
export const buildWat = (text: string, memory = '(memory (export "memory") 40 512)') =>
	buildModule(`(module ${memory} ${text})`);

const overlaps = (exclusions: [number, number][], from: number, to: number) =>
	exclusions.some(([a, b]) => from < b && a < to);

export interface Failure {
	check: string;
	pattern: string;
	ptr: number;
	len: number;
	state: string;
	detail: string;
}

export interface Ground {
	failure: Failure | undefined;
	checks: number;
	skipped: number;
	combos: number;
}

function detectBits(fn: Function): 32 | 64 {
	try {
		fn(0, 0, 0);
		return 32;
	} catch (e) {
		return e instanceof TypeError ? 64 : 32;
	}
}

// instance-level ground truth: each combination runs on a fresh instance with the input at ptr, then
// the claim call, a second call, every two-part chain, the model over uneven chunks from state zero
// (with a certificate), a byte chain for short inputs and the bytes just outside the range
export function ground(
	bytes: Uint8Array,
	entry: string,
	cert: StreamCertificate | undefined,
	full: boolean
): Ground {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const probe = new WebAssembly.Instance(mod, {});
	const bits = cert ? cert.bits : detectBits(probe.exports[entry] as Function);
	const mask = (1n << BigInt(bits)) - 1n;
	const states = bits === 32 ? STATES32 : STATES64;
	const exclusions = cert ? cert.exclusions : [];
	const out: Ground = { failure: undefined, checks: 0, skipped: 0, combos: 0 };
	const lens = full ? LENS_FULL : LENS_LIGHT;
	const patterns: ['rand' | 'zero' | 'ff' | 'asc', number][] = full
		? [
				['rand', 1],
				['zero', 0],
				['ff', 0],
				['asc', 0]
			]
		: [['rand', 1]];
	const inputs = new Map<string, Uint8Array>();
	for (const [kind, seed] of patterns) inputs.set(kind, patternBytes(kind, seed + 17));

	const fail = (
		check: string,
		pattern: string,
		ptr: number,
		len: number,
		state: bigint,
		detail: string
	) => {
		out.failure = { check, pattern, ptr, len, state: `0x${state.toString(16)}`, detail };
		return out;
	};

	try {
		for (const len of lens) {
			for (const [kind] of patterns) {
				const data = inputs.get(kind)!;
				const ptrs = full && kind === 'rand' ? PTR_OFFS : [1];
				const sts = full && kind === 'rand' ? states : [states[0]!, states[4]!];
				for (const off of ptrs) {
					const ptr = BASE + off;
					for (const s of sts) {
						out.combos++;
						if (ptr + len > 0xffffffff || overlaps(exclusions, ptr, ptr + len)) {
							out.skipped++;
							continue;
						}
						const inst = new WebAssembly.Instance(mod, {});
						const memory = inst.exports.memory as WebAssembly.Memory;
						const need = Math.ceil((ptr + len + 64) / PAGE);
						if (memory.buffer.byteLength < need * PAGE)
							memory.grow(need - memory.buffer.byteLength / PAGE);
						new Uint8Array(memory.buffer, ptr, len).set(data.subarray(0, len));
						const fn = inst.exports[entry] as Function;
						const call = (state: bigint, at: number, n: number): bigint => {
							const arg =
								bits === 64
									? BigInt.asIntN(64, state)
									: Number(BigInt.asIntN(32, state));
							const r = fn(arg, at, n);
							return bits === 64
								? BigInt.asUintN(64, r as bigint)
								: BigInt((r as number) >>> 0);
						};
						const whole = call(s, ptr, len);
						out.checks++;
						if (cert) {
							for (const r of cert.image) {
								if (
									sha256(new Uint8Array(memory.buffer, r.address, r.length)) !==
									r.sha256
								)
									return fail(
										'image',
										kind,
										ptr,
										len,
										s,
										`image at ${r.address} length ${r.length} differs after the first call`
									);
							}
							out.checks++;
						}
						const again = call(s, ptr, len);
						out.checks++;
						if (again !== whole)
							return fail(
								'warm call',
								kind,
								ptr,
								len,
								s,
								`first ${whole} second ${again}`
							);

						const cuts = [1, Math.floor(len / 3), Math.floor(len / 2), len - 1].filter(
							(c, i, a) => c >= 1 && c < len && a.indexOf(c) === i
						);
						for (const cut of cuts) {
							const x = call(s, ptr, cut);
							const y = call(x, ptr + cut, len - cut);
							out.checks++;
							if (y !== whole)
								return fail(
									'chain',
									kind,
									ptr,
									len,
									s,
									`cut ${cut} whole ${whole} chain ${y}`
								);
						}

						if (len <= 300 && full) {
							let x = s & mask;
							for (let i = 0; i < len; i++) x = call(x, ptr + i, 1);
							out.checks++;
							if (x !== whole)
								return fail(
									'byte chain',
									kind,
									ptr,
									len,
									s,
									`whole ${whole} bytes ${x}`
								);
						}

						const widths = full ? [2, 3, 5, 8] : [2, 3];
						for (const w of widths) {
							if (len < w) continue;
							const rnd = mulberry(len * 31 + w * 7 + off);
							const cuts2 = new Set<number>();
							while (cuts2.size < w - 1) cuts2.add(1 + Math.floor(rnd() * (len - 1)));
							const bounds = [0, ...[...cuts2].sort((p, q) => p - q), len];
							let combined = s & mask;
							const chunks: string[] = [];
							for (let k = 0; k + 1 < bounds.length; k++) {
								const from = bounds[k]!;
								const to = bounds[k + 1]!;
								if (to <= from) continue;
								const part = call(0n, ptr + from, to - from);
								chunks.push(`${from}-${to}`);
								if (cert)
									combined = predictEnd(cert.model, combined, to - from, part);
								else combined = call(combined, ptr + from, to - from);
							}
							out.checks++;
							if (combined !== whole)
								return fail(
									cert ? 'model' : 'chunks',
									kind,
									ptr,
									len,
									s,
									`chunks ${chunks.join(' ')} whole ${whole} combined ${combined}`
								);
						}

						if (full && len <= 65537) {
							for (const at of [ptr + len, ptr - 1]) {
								if (overlaps(exclusions, at, at + 1)) continue;
								const old =
									memory.buffer.byteLength > at
										? new Uint8Array(memory.buffer, at, 1)[0]!
										: -1;
								if (old < 0) continue;
								new Uint8Array(memory.buffer, at, 1)[0] = (old ^ 0xa5) & 255;
								const moved = call(s, ptr, len);
								new Uint8Array(memory.buffer, at, 1)[0] = old;
								out.checks++;
								if (moved !== whole)
									return fail(
										'outside byte',
										kind,
										ptr,
										len,
										s,
										`byte ${at - ptr} changed the result`
									);
							}
						}
					}
				}
			}
		}
	} catch (e) {
		return {
			...out,
			failure: {
				check: 'trap',
				pattern: '',
				ptr: 0,
				len: 0,
				state: '',
				detail: String(e).slice(0, 160)
			}
		};
	}
	return out;
}

export interface Judgement {
	status: 'accepted' | 'refused';
	reason: string;
	wrong: boolean;
	composes: boolean | undefined;
	failure: Failure | undefined;
	checks: number;
	skipped: number;
	combos: number;
	cert?: StreamCertificate;
	ms: number;
}

// certifies, then runs the full ground truth on acceptances and the light check on refusals
export function judge(bytes: Uint8Array, entry = 'update'): Judgement {
	const t0 = performance.now();
	let result: StreamCertificate | CertificateRefusal;
	try {
		result = certifyStream(bytes, entry);
	} catch (e) {
		return {
			status: 'refused',
			reason: `THROW ${String(e).slice(0, 120)}`,
			wrong: false,
			composes: undefined,
			failure: undefined,
			checks: 0,
			skipped: 0,
			combos: 0,
			ms: performance.now() - t0
		};
	}
	if (result.kind === 'refusal') {
		let g: Ground | undefined;
		let err = '';
		try {
			g = ground(bytes, entry, undefined, false);
		} catch (e) {
			err = String(e).slice(0, 120);
		}
		return {
			status: 'refused',
			reason: result.reason.slice(0, 300),
			wrong: false,
			composes: g ? g.failure === undefined : undefined,
			failure:
				g?.failure ??
				(err
					? { check: 'harness', pattern: '', ptr: 0, len: 0, state: '', detail: err }
					: undefined),
			checks: g?.checks ?? 0,
			skipped: g?.skipped ?? 0,
			combos: g?.combos ?? 0,
			ms: performance.now() - t0
		};
	}
	const g = ground(bytes, entry, result, true);
	return {
		status: 'accepted',
		reason: '',
		wrong: g.failure !== undefined,
		composes: g.failure === undefined,
		failure: g.failure,
		checks: g.checks,
		skipped: g.skipped,
		combos: g.combos,
		cert: result,
		ms: performance.now() - t0
	};
}

// #region reviewer fuzzers

const FUZZ_INPUT = Uint8Array.from(
	{ length: 4096 },
	(_, k) => (Math.imul(k + 7, 2654435761) >>> 11) & 255
);
const FUZZ_BASE = 2048;

// entry(state, FUZZ_BASE + at, len) on a fresh instance; a trap comes back as a string
export function callAt(
	bytes: Uint8Array,
	entry: string,
	state: number | bigint,
	at: number,
	len: number,
	bits: 32 | 64 = 32
): bigint | string {
	try {
		const inst = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {});
		const memory = inst.exports.memory as WebAssembly.Memory;
		new Uint8Array(memory.buffer, FUZZ_BASE, FUZZ_INPUT.length).set(FUZZ_INPUT);
		const s =
			bits === 64
				? BigInt.asIntN(64, BigInt(state))
				: Number(BigInt.asIntN(32, BigInt(state)));
		const r = (inst.exports[entry] as Function)(s, FUZZ_BASE + at, len);
		return BigInt.asUintN(bits, BigInt(r));
	} catch (e) {
		return 'trap ' + String(e).slice(0, 60);
	}
}

// for every split into two chunks, the model over zero-start chunk results must equal the serial
// result, and so must plain chained calls; returns the counterexamples
export function chunkCheck(
	bytes: Uint8Array,
	entry: string,
	cert: StreamCertificate,
	lens: number[],
	states = [0, 1, 0x80000000, 0xffffffff, 0x1234567]
): string[] {
	const out: string[] = [];
	const bits = cert.bits as 32 | 64;
	for (const len of lens)
		for (const s of states) {
			const whole = callAt(bytes, entry, s, 0, len, bits);
			if (typeof whole === 'string') {
				out.push(`len ${len} state ${s}: ${whole}`);
				continue;
			}
			for (const cut of new Set([1, Math.floor(len / 2), len - 1])) {
				if (cut < 1 || cut >= len) continue;
				const a = callAt(bytes, entry, 0, 0, cut, bits);
				const b = callAt(bytes, entry, 0, cut, len - cut, bits);
				if (typeof a === 'string' || typeof b === 'string') continue;
				let m = BigInt.asUintN(bits, BigInt(s));
				m = predictEnd(cert.model, m, cut, a);
				m = predictEnd(cert.model, m, len - cut, b);
				if (m !== whole)
					out.push(`MODEL len ${len} cut ${cut} state ${s}: serial ${whole} model ${m}`);
				const c1 = callAt(bytes, entry, s, 0, cut, bits);
				if (typeof c1 === 'string') continue;
				const c2 = callAt(bytes, entry, c1, cut, len - cut, bits);
				if (c2 !== whole)
					out.push(`CHAIN len ${len} cut ${cut} state ${s}: serial ${whole} chain ${c2}`);
			}
		}
	return out;
}

// chunk result of `length` bytes when the byte step ignores the input, by doubling the certified step
export function zeroRun(cert: StreamCertificate, length: number): bigint {
	let power = cert.output!.step!;
	let size = 1;
	let result = 0n;
	for (let n = length; n > 0; n = Math.floor(n / 2)) {
		if (n % 2 === 1) result = predictEnd(cert.model, result, size, power);
		power = predictEnd(cert.model, power, size, power);
		size *= 2;
	}
	return result;
}

// certifies a denial-of-service module under the gf2 ring and prints the seconds it took
export function timedCertify(text: string) {
	const bytes = buildModule(text);
	const t = performance.now();
	const r = certifyStream(bytes, 'update', { ring: 'gf2' });
	console.log(r.kind === 'refusal' ? `refused: ${r.reason}` : `certified (${r.ring})`);
	console.log('seconds', ((performance.now() - t) / 1000).toFixed(1));
}

// #endregion
