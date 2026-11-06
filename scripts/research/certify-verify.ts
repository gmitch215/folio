import { createHash } from 'node:crypto';
import type { StreamCertificate } from '../../src/certify.ts';
import { Machine, Mem, type Val } from './certify-verify-machine.ts';
import {
	MASK,
	Refuse,
	resetAtoms,
	RINGS,
	type Form,
	type Op,
	type Ring,
	type W
} from './certify-verify-rings.ts';
import { decode, DecodeError, type WModule } from './certify-verify-wasm.ts';

export interface VerifyOptions {
	// lengths 1 to this one run at the first pointer; the default is 80
	full?: number;
	// lengths above `full` that run at the first pointer
	big?: number[];
	// lengths that run at the other pointers
	some?: number[];
	// lengths run on the module itself, with concrete bytes, because the derivation is too large
	huge?: number[];
	// bytes the symbolic state may retain before the run refuses
	memory?: number;
	// interpreter steps for the whole run before it refuses
	steps?: number;
}

export interface Verdict {
	ok: boolean;
	reason: string;
	cases: number;
}

const PAGE = 65536;
const BIG = [127, 128, 129, 255, 256, 257, 513, 1000];
const SOME = [1, 2, 3, 4, 5, 8, 15, 16, 17, 31, 32, 33, 48, 63, 64, 65, 100];
const HUGE = [65535, 65536, 65537, 70001, 131072, 131073, 1 << 20];
// one call may take this many steps plus a share per input byte; a cold call may fill a table
const CALL_STEPS = 250_000;
const BYTE_STEPS = 2_000;
const TOTAL_STEPS = 60_000_000;
const MAX_MEMORY = 1 << 28;
// a long run is skipped as too slow when the last length, scaled by the square, would pass this
const SLOW_MS = 60_000;

const clearOf = (at: number, n: number, spans: [number, number][]): number | undefined => {
	let p = at;
	for (;;) {
		if (p < 0) return undefined;
		const hit = spans.find(([from, to]) => from < p + n && to > p);
		if (!hit) return p;
		p = hit[0] - n;
	}
};

const junkOutside = (mem: Uint8Array, keep: [number, number][]) => {
	let x = 12345;
	let at = 0;
	const fill = (to: number) => {
		for (; at < to; at++) {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			mem[at] = x >>> 24;
		}
	};
	for (const [from, to] of [...keep].sort((a, b) => a[0] - b[0])) {
		fill(Math.min(from, mem.length));
		at = Math.max(at, to);
	}
	fill(mem.length);
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const merged = (list: number[]): [number, number][] => {
	const sorted = [...new Set(list)].sort((a, b) => a - b);
	const out: [number, number][] = [];
	for (const a of sorted) {
		const top = out[out.length - 1];
		if (top && a === top[1]) top[1] = a + 1;
		else out.push([a, a + 1]);
	}
	return out;
};

const covered = (ranges: [number, number][], a: number) =>
	ranges.some(([from, to]) => a >= from && a < to);

class No extends Error {}
const no = (why: string): never => {
	throw new No(why);
};

export function verifyCertificate(
	bytes: Uint8Array,
	cert: StreamCertificate,
	options: VerifyOptions = {}
): Verdict {
	let cases = 0;
	try {
		cases = run(bytes, cert, options);
		return { ok: true, reason: '', cases };
	} catch (error) {
		if (error instanceof No || error instanceof Refuse || error instanceof DecodeError)
			return { ok: false, reason: error.message, cases };
		return { ok: false, reason: `internal: ${(error as Error).message}`, cases };
	}
}

function certOperator(cert: StreamCertificate): Op {
	const m = cert.model;
	if (cert.ring === 'gf2') {
		if (!Array.isArray(m.operator) || m.operator.length !== cert.bits)
			return no('the operator is not a column list');
		if (m.operator.some((c) => typeof c !== 'bigint'))
			return no('operator entries are not bigint');
		return { k: 'gf2', cols: m.operator as bigint[] };
	}
	if (cert.ring === 'z2w') {
		if (typeof m.operator !== 'bigint') return no('the multiplier is not a bigint');
		return { k: 'z2w', m: m.operator, bits: cert.bits };
	}
	if (!Array.isArray(m.operator) || m.operator.length !== 4 || typeof m.modulus !== 'bigint')
		return no('the residue operator is not a 2 by 2 matrix with a modulus');
	if (m.operator.some((c) => typeof c !== 'bigint')) return no('operator entries are not bigint');
	if (m.digits !== 2 || cert.bits !== 32)
		return no('residue model needs two digits of a 32-bit state');
	return { k: 'zp', p: m.modulus, mat: m.operator as bigint[] };
}

const eqVal = (ring: Ring, a: Val, b: Val) =>
	typeof a === 'bigint' || typeof b === 'bigint'
		? a === b
		: ring.key(a as Form) === ring.key(b as Form);

function run(bytes: Uint8Array, cert: StreamCertificate, options: VerifyOptions): number {
	// fields
	if (cert.kind !== 'certificate' || cert.schema !== 'folio.certificate.v1')
		no('not a certificate of this schema');
	if (!(cert.ring in RINGS)) no('unknown ring');
	if (cert.bits !== 32 && cert.bits !== 64) no('bad width');
	const bits: W = cert.bits;
	if (cert.model?.kind !== 'model' || cert.model.ring !== cert.ring) no('model ring differs');
	if (cert.model.bits !== bits || cert.model.align !== 1) no('model width or alignment differs');
	const lay = cert.layout;
	if (
		lay.entry !== cert.entry ||
		lay.bits !== bits ||
		JSON.stringify(cert.model.layout) !== JSON.stringify(lay)
	)
		no('layout differs');
	if (
		new Set([lay.state, lay.ptr, lay.len]).size !== 3 ||
		![lay.state, lay.ptr, lay.len].every((x) => x === 0 || x === 1 || x === 2)
	)
		no('bad parameter positions');
	if (sha256(bytes) !== cert.moduleSha256) no('the certificate describes a different module');
	if (cert.zeroLength !== 'identity' && cert.zeroLength !== 'transforms')
		no('bad zero length field');
	if (
		!Array.isArray(cert.image) ||
		!Array.isArray(cert.initialization) ||
		!Array.isArray(cert.exclusions)
	)
		no('missing memory fields');
	const certOp = certOperator(cert);
	if (cert.output !== undefined && cert.output.inPlace !== true) no('bad output field');
	const step = cert.output?.step;
	if (step !== undefined && typeof step !== 'bigint') no('step is not a bigint');
	const excl = cert.exclusions;
	for (const e of excl)
		if (
			!Array.isArray(e) ||
			e.length !== 2 ||
			!Number.isSafeInteger(e[0]) ||
			!Number.isSafeInteger(e[1]) ||
			e[0] >= e[1]
		)
			no('a malformed exclusion');

	// module
	const mod: WModule = decode(bytes);
	if (mod.imports) no('the module has imports');
	if (mod.memories !== 1) no('the module does not have exactly one memory');
	if (mod.start !== undefined) no('the module has a start function');
	const exported = mod.exports.get(cert.entry);
	if (!exported || exported.kind !== 0) no('no such function export');
	const fn = mod.funcs[exported!.index];
	if (!fn) no('the export is not a defined function');
	const stateType = bits === 32 ? 0x7f : 0x7e;
	const params = fn!.type.params;
	if (
		params.length !== 3 ||
		params[lay.state] !== stateType ||
		params[lay.ptr] !== 0x7f ||
		params[lay.len] !== 0x7f ||
		fn!.type.results.length !== 1 ||
		fn!.type.results[0] !== stateType
	)
		no('the entry signature differs from the layout');
	const M = mod.initialPages * PAGE;
	if (M > MAX_MEMORY) no('the initial memory is over 256 MiB');
	const base = new Uint8Array(M);
	for (const seg of mod.data) {
		if (seg.offset + seg.bytes.length > M) no('a data segment lies outside memory');
		base.set(seg.bytes, seg.offset);
	}

	const ring = RINGS[cert.ring];
	resetAtoms(options.memory);
	const fnIndex = exported!.index;
	const stateForm = ring.state(bits);
	const claimOp = (n: number) => ring.opPow(certOp, n);
	let stepsLeft = options.steps ?? TOTAL_STEPS;

	const callOnce = (mem: Mem, state: Val, ptr: number, n: number): Val => {
		const limit = Math.min(CALL_STEPS + BYTE_STEPS * n, stepsLeft);
		const machine = new Machine(mod, ring, mem, limit);
		const args: Val[] = [0n, 0n, 0n];
		args[lay.state] = state;
		args[lay.ptr] = BigInt(ptr);
		args[lay.len] = BigInt(n);
		let out: Val | undefined;
		try {
			out = machine.call(fnIndex, args)[0];
		} catch (error) {
			stepsLeft -= machine.steps;
			if (error instanceof Refuse && error.message === 'step limit' && stepsLeft <= 0)
				no('the step budget of the whole run is spent');
			throw error;
		}
		stepsLeft -= machine.steps;
		if (out === undefined) return no('the entry returns nothing');
		return out;
	};

	const cold = () => new Mem(ring, base, M);
	let warmBase = base;
	let init = new Map<number, bigint>();
	const ext = new Set<number>();
	const readsCold = new Set<number>();
	const readsWarm = new Set<number>();
	let hasOut = false;
	let cases = 0;

	const sameMap = (a: Map<number, bigint>, b: Map<number, bigint>) =>
		a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

	// discovery: what lies outside the input, at two pointers and every length
	const lengths: number[] = [];
	const full = options.full ?? 80;
	for (let n = 1; n <= full; n++) lengths.push(n);
	lengths.push(...(options.big ?? BIG).filter((n) => n > full));
	// the two probe placements sit clear of the certificate's exclusions, which may hold a fixed read
	// at the end of a small memory; widening an exclusion only shrinks where inputs may go
	const ptrA = (n: number) => clearOf(M - n, n, excl);
	const ptrB = (n: number) => {
		const a = ptrA(n);
		return a === undefined ? undefined : clearOf(a - 8193, n, excl);
	};
	const dataEnd = Math.max(0, ...mod.data.map((s) => s.offset + s.bytes.length));
	const farB = ptrB(1000);
	if (farB === undefined || farB < dataEnd + 16)
		no('memory is too small to place the input clear of the data');

	let firstInit = true;
	for (const n of lengths) {
		const sets: Set<number>[] = [];
		for (const P of [ptrA(n), ptrB(n)]) {
			if (P === undefined) return no(`no placement of ${n} bytes is clear of the exclusions`);
			const mem = cold();
			mem.begin([P, P + n], P);
			callOnce(mem, stateForm, P, n);
			if (firstInit) {
				init = new Map(mem.writes);
				firstInit = false;
			} else if (!sameMap(init, mem.writes))
				no('the first call writes different bytes at different calls');
			const s = new Set<number>([...mem.reads, ...mem.writes.keys()]);
			for (const a of mem.reads) readsCold.add(a);
			sets.push(s);
		}
		const [sa, sb] = sets as [Set<number>, Set<number>];
		if (sa.size !== sb.size || [...sa].some((a) => !sb.has(a)))
			no(`memory outside the input depends on the pointer at length ${n}`);
		for (const a of sa) ext.add(a);
	}
	const extRanges = merged([...ext]);
	if (init.size) {
		warmBase = base.slice();
		for (const [a, v] of init) warmBase[a] = Number(v);
	}
	const allowed = (a: number) => ext.has(a);

	const normalized = (mem: Mem, P: number, n: number) => {
		const out = new Map<number, string>();
		for (const [a, v] of mem.over) {
			const inside = a >= P && a < P + n;
			if (typeof v === 'bigint') {
				if (!inside && v === BigInt(warmBase[a] ?? 0)) continue;
				out.set(a, `c${v}`);
			} else {
				if (inside && ring.key(v) === ring.key(ring.byte(a - P))) continue;
				out.set(a, ring.key(v));
			}
		}
		return out;
	};
	const sameOverlay = (a: Map<number, string>, b: Map<number, string>) =>
		a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

	const checkCase = (P: number | undefined, n: number) => {
		if (P === undefined || P < 0 || P + n > M) return;
		for (let a = P; a < P + n; a++) if (covered(extRanges, a)) return;
		cases++;
		// the fold, one byte per call on one memory
		const seq = cold();
		let S: Val = stateForm;
		for (let i = 0; i < n; i++) {
			seq.begin([P + i, P + i + 1], P, allowed);
			S = callOnce(seq, S, P + i, 1);
			if (i > 0) for (const a of seq.reads) readsWarm.add(a);
		}
		const whole = cold();
		whole.begin([P, P + n], P, allowed);
		const R = callOnce(whole, stateForm, P, n);
		const warm = new Mem(ring, warmBase, M);
		warm.begin([P, P + n], P, allowed);
		const Rw = callOnce(warm, stateForm, P, n);
		for (const a of warm.reads) readsWarm.add(a);
		if (!eqVal(ring, S, R))
			no(`the whole call differs from the fold at length ${n}, pointer ${P}`);
		if (!eqVal(ring, S, Rw))
			no(`a warm call differs from the first call at length ${n}, pointer ${P}`);
		const ns = normalized(seq, P, n);
		const nw = normalized(whole, P, n);
		if (!sameOverlay(ns, nw))
			no(`memory after the whole call differs from the fold at length ${n}`);
		if (!sameOverlay(normalized(warm, P, n), nw))
			no(`memory after a warm call differs at length ${n}`);
		for (const [a] of ns) if (a >= P && a < P + n) hasOut = true;
		const Sf: Form = typeof S === 'bigint' ? ring.konst(S, bits) : S;
		const op = ring.linear(Sf, bits);
		if (!ring.opEq(op, claimOp(n)))
			no(`the model operator does not match the fold at length ${n}`);
		if (step !== undefined) {
			if (ring.hasBytes(Sf))
				no('the state step reads the input bytes but the certificate has a step');
			const c = ring.zeroConst(Sf);
			if (c === undefined) no('step is not supported in this ring');
			let z = 0n;
			const one = ring.opPow(certOp, 1);
			for (let i = 0; i < n; i++)
				z =
					cert.ring === 'gf2'
						? ring.opApply(one, z) ^ step
						: (ring.opApply(one, z) + step) & MASK(bits);
			if (z !== c) no(`the step does not reproduce the byte-free fold at length ${n}`);
		}
	};

	const some = options.some ?? SOME;
	for (const n of lengths) checkCase(ptrA(n), n);
	for (const n of lengths) checkCase(ptrB(n), n);
	for (const n of some) {
		for (const P of [Math.floor(M / 2) + 3, (ext.size ? Math.max(...ext) : 0) + 1, 0, 1, 3])
			checkCase(P, n);
	}
	if (cases === 0) no('no pointer placed an input clear of the memory the call touches');

	// zero length
	{
		const mem = cold();
		mem.begin([M, M], M);
		const R = callOnce(mem, stateForm, M, 0);
		if (cert.zeroLength === 'identity' && !eqVal(ring, R, stateForm))
			no('a call over zero bytes is not the identity');
	}

	// certificate fields against what the runs touched
	if ((cert.output !== undefined) !== hasOut)
		no(
			hasOut
				? 'the call rewrites its input but the certificate has no output'
				: 'the certificate has an output the call does not produce'
		);
	const wantInit: { address: number; hex: string }[] = [];
	for (const a of [...init.keys()].sort((x, y) => x - y)) {
		const top = wantInit[wantInit.length - 1];
		const h = Number(init.get(a)).toString(16).padStart(2, '0');
		if (top && top.address + top.hex.length / 2 === a) top.hex += h;
		else wantInit.push({ address: a, hex: h });
	}
	if (JSON.stringify(wantInit) !== JSON.stringify(cert.initialization))
		no('initialization differs from the bytes the first call writes');
	const imageRanges: [number, number][] = [];
	for (const r of cert.image) {
		if (
			!Number.isSafeInteger(r.address) ||
			!Number.isSafeInteger(r.length) ||
			r.address < 0 ||
			r.length < 0 ||
			r.address + r.length > M
		)
			no('an image range lies outside memory');
		if (sha256(warmBase.subarray(r.address, r.address + r.length)) !== r.sha256)
			no('an image digest differs from the memory');
		imageRanges.push([r.address, r.address + r.length]);
	}
	for (const a of readsWarm)
		if (!covered(imageRanges, a)) no(`the call reads byte ${a}, which no image range holds`);
	for (const a of [...ext, ...readsCold, ...readsWarm])
		if (!covered(excl, a)) no(`the call touches byte ${a}, which no exclusion covers`);

	// lengths the derivation cannot reach (a form names at most 4096 input bytes): the module itself
	// runs on concrete bytes and must agree with the model, with the fold split at two points, with
	// junk in the memory it may not read, and with no write outside the input
	const huge = [...new Set(options.huge ?? HUGE)]
		.filter((n) => n >= 1 && n <= M)
		.sort((a, b) => a - b);
	if (huge.length) cases += longRuns(huge);
	return cases;

	function longRuns(list: number[]): number {
		const memory = [...mod.exports].find(([, e]) => e.kind === 2)?.[0];
		if (memory === undefined) return no('the module does not export its memory');
		const wasm = new WebAssembly.Module(Uint8Array.from(bytes));
		const mask = MASK(bits);
		const spans: [number, number][] = [...excl, ...extRanges];
		const input = new Uint8Array(list[list.length - 1]!);
		let x = 7;
		for (let i = 0; i < input.length; i++) {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			input[i] = x >>> 24;
		}
		const s1 = 0x9e3779b97f4a7c15n & mask;
		const predict = (n: number, s: bigint, end0: bigint): bigint => {
			const op = ring.opPow(certOp, n);
			if (op.k === 'gf2') return ring.opApply(op, s) ^ end0;
			if (op.k === 'z2w') return (ring.opApply(op, s) + end0) & mask;
			const [d0, d1] = [s & 0xffffn, s >> 16n];
			const lo = (op.mat[0]! * d0 + op.mat[1]! * d1 + (end0 & 0xffffn)) % op.p;
			const hi = (op.mat[2]! * d0 + op.mat[3]! * d1 + (end0 >> 16n)) % op.p;
			return lo | (hi << 16n);
		};
		const run = (P: number, n: number, state: bigint, pieces: number[], junk: boolean) => {
			const instance = new WebAssembly.Instance(wasm, {});
			const mem = new Uint8Array((instance.exports[memory] as WebAssembly.Memory).buffer);
			if (mem.length !== M) no('the memory of a new instance differs from the declared size');
			if (junk) junkOutside(mem, [[P, P + n], ...excl]);
			mem.set(input.subarray(0, n), P);
			const fn = instance.exports[cert.entry] as (
				...a: (number | bigint)[]
			) => number | bigint;
			let s = state;
			let at = 0;
			try {
				for (const len of pieces) {
					const args: (number | bigint)[] = [0, 0, 0];
					args[lay.state] =
						bits === 32 ? Number(BigInt.asIntN(32, s)) : BigInt.asIntN(64, s);
					args[lay.ptr] = P + at;
					args[lay.len] = len;
					s = BigInt.asUintN(bits, BigInt(fn(...args)));
					at += len;
				}
			} catch (error) {
				return no(`the module traps at length ${n}: ${(error as Error).message}`);
			}
			return { end: s, mem, own: mem.subarray(P, P + n) };
		};
		let last: [number, number] | undefined;
		let done = 0;
		for (const n of list) {
			const P = clearOf(M - n, n, spans);
			if (P === undefined) continue;
			if (last && last[1] * (n / last[0]) ** 2 > SLOW_MS)
				no(`the module is too slow at length ${n} to run it`);
			const t0 = performance.now();
			const whole = run(P, n, s1, [n], false);
			const zero = run(P, n, 0n, [n], false);
			if (whole.end !== predict(n, s1, zero.end))
				no(`the module disagrees with the model at length ${n}`);
			if (
				Buffer.compare(whole.mem.subarray(0, P), warmBase.subarray(0, P)) !== 0 ||
				Buffer.compare(whole.mem.subarray(P + n), warmBase.subarray(P + n)) !== 0
			)
				no(`the module writes outside its input at length ${n}`);
			if (cert.output === undefined && Buffer.compare(whole.own, input.subarray(0, n)) !== 0)
				no(`the module rewrites its input at length ${n}`);
			const junk = run(P, n, s1, [n], true);
			if (junk.end !== whole.end || Buffer.compare(junk.own, whole.own) !== 0)
				no(`the module reads memory it does not name at length ${n}`);
			for (const cut of new Set([1, n > 65536 ? 65536 : n >> 1])) {
				if (cut < 1 || cut >= n) continue;
				const split = run(P, n, s1, [cut, n - cut], false);
				if (split.end !== whole.end || Buffer.compare(split.own, whole.own) !== 0)
					no(`the module differs when the fold is split at ${cut} at length ${n}`);
			}
			last = [n, performance.now() - t0];
			done++;
		}
		return done;
	}
}
