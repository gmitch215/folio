import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { certifyStream, type StreamCertificate } from '../../../../src/certify.ts';
import { groundTruth } from '../../../../scripts/research/certify-ground.ts';
import { verifyCertificate } from '../../../../scripts/research/certify-verify.ts';
import {
	ground2,
	pickBase,
	placed,
	pointerSpots
} from '../../../../scripts/research/adversary/round3/lib.ts';

// round 4 harness: one module in, one row out. The checker, the independent verifier and the
// execution ground truth all run on the same bytes.

export interface Rec {
	id: string;
	family: string;
	file: string;
	entry?: string;
	/** a module whose certificate is borrowed (digest patched) to test the verifier alone */
	base?: string;
	note?: string;
}

export interface Row {
	id: string;
	family: string;
	sha256: string;
	checker: 'accepted' | 'refused' | 'RAW' | 'bad-module';
	reason?: string;
	ring?: string;
	output?: boolean;
	verifier?: 'accepts' | 'rejects' | 'RAW' | '-';
	vreason?: string;
	ground?: string;
	ground2?: string;
	borrowed?: 'verifier-accepts' | 'verifier-rejects' | '-';
	bground?: string;
	long?: boolean;
	kind: string;
	ms: number;
	note?: string;
}

// the reduced options of certify-verify-run.ts; the full ones cost 17 s on crc32c under load
export const VOPT = process.env.VFULL
	? {}
	: { full: 24, big: [] as number[], some: [1, 2, 3, 16, 17, 33] };

export const sha =(b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const baseCerts = new Map<string, StreamCertificate | null>();
function baseCert(path: string, entry: string): StreamCertificate | null {
	if (!baseCerts.has(path)) {
		const c = certifyStream(new Uint8Array(readFileSync(path)), entry);
		baseCerts.set(path, c.kind === 'certificate' ? c : null);
	}
	return baseCerts.get(path)!;
}

const probe = Uint8Array.from({ length: 200 }, (_, k) => (Math.imul(k + 1, 2654435761) >>> 11) & 255);

/** The start-of-memory and end-of-memory pointers of ground2, for windows that clear every exclusion. */
function pointerCheck(bytes: Uint8Array, cert: StreamCertificate): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	for (const len of [1, 2, 3, 17, 100]) {
		const { spots } = pointerSpots(mod, cert, len);
		if (spots.length < 2) continue;
		let want: ReturnType<typeof placed> | undefined;
		try {
			want = placed(mod, cert, spots[0]!, probe.subarray(0, len), 9n);
		} catch {
			return `trap at the reference pointer ${spots[0]} len ${len}`;
		}
		for (const at of spots.slice(1)) {
			let got;
			try {
				got = placed(mod, cert, at, probe.subarray(0, len), 9n);
			} catch (e) {
				return `trap at pointer ${at} len ${len}: ${String(e).slice(0, 60)}`;
			}
			if (got.end !== want.end) return `pointer ${at} len ${len} end ${got.end} want ${want.end}`;
			if (cert.output && got.bytes !== want.bytes) return `pointer ${at} len ${len} bytes differ`;
		}
	}
	return '';
}

const norm = (s: string) =>
	s
		.replace(/0x[0-9a-f]+/gi, 'N')
		.replace(/\d+/g, 'N')
		.slice(0, 110);

const rnd = Uint8Array.from({ length: (1 << 20) + 128 }, (_, k) => (Math.imul(k + 7, 2246822519) >>> 13) & 255);

/** Whole call against calls cut at 2^16 boundaries and elsewhere, at lengths ground2 never reaches. */
function longCheck(bytes: Uint8Array, cert: StreamCertificate): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const LONGEST = 1 << 20;
	const base = [1 << 20, 4 << 20, 8 << 20].find((b) =>
		cert.exclusions.every(([f, t]) => b + LONGEST + 4096 <= f || b >= t)
	);
	if (base === undefined) return '';
	const pages = Math.ceil((base + LONGEST + 4096) / 65536);
	const m = (1n << BigInt(cert.bits)) - 1n;
	const mk = () => {
		const inst = new WebAssembly.Instance(mod, {});
		const mem = inst.exports.memory as WebAssembly.Memory;
		if (mem.buffer.byteLength < pages * 65536) mem.grow(pages - mem.buffer.byteLength / 65536);
		new Uint8Array(mem.buffer, base, rnd.length).set(rnd);
		const fn = inst.exports[cert.entry] as (...a: (number | bigint)[]) => number | bigint;
		const { layout, bits } = cert;
		return {
			mem,
			call(s: bigint, at: number, len: number): bigint {
				const args: (number | bigint)[] = [0, 0, 0];
				args[layout.state] = bits === 32 ? Number(BigInt.asIntN(32, s)) : BigInt.asIntN(64, s);
				args[layout.ptr] = base + at;
				args[layout.len] = len;
				return BigInt.asUintN(bits, BigInt(fn(...args)));
			}
		};
	};
	const region = (mem: WebAssembly.Memory, len: number) => Buffer.from(mem.buffer, base, len);
	for (const len of [65536, 65537, 70001, 131073, 1 << 20]) {
		for (const s of [1n, 0xdeadbeefcafef00dn & m]) {
			const w = mk();
			let end: bigint;
			try {
				end = w.call(s, 0, len);
			} catch (e) {
				return `trap at long length ${len}: ${String(e).slice(0, 50)}`;
			}
			for (const cut of [65536, 1, Math.floor(len / 2), len - 1]) {
				if (cut < 1 || cut >= len) continue;
				const c = mk();
				let e2: bigint;
				try {
					e2 = c.call(c.call(s, 0, cut), cut, len - cut);
				} catch (e) {
					return `trap in chain at long length ${len} cut ${cut}: ${String(e).slice(0, 50)}`;
				}
				if (e2 !== end) return `long chain end length ${len} cut ${cut} state ${s}`;
				if (cert.output && Buffer.compare(region(w.mem, len), region(c.mem, len)))
					return `long chain bytes length ${len} cut ${cut} state ${s}`;
			}
		}
	}
	return '';
}

/** Every ground truth check on one certificate; the first disagreement, or an empty string. */
function truth(bytes: Uint8Array, cert: StreamCertificate, heavy: boolean, notes: string[]): string {
	try {
		let g = groundTruth(bytes, cert, [1, 2, 17, 257, 4097], pickBase(cert));
		if (cert.initialization.length && /writes outside the input/.test(g)) g = '';
		if (g) return g;
		g = ground2(bytes, cert, heavy);
		// ground2 tests each exclusion alone, so a window that sits against one and into another
		// is its own false alarm; skip those and run the pointer-spot checks it skipped
		const m = /^(?:exclusion boundary (?:bytes )?\d+-\d+|trap beside exclusion \d+-\d+) at (\d+) len (\d+)/.exec(g);
		if (m) {
			const at = Number(m[1]);
			const len = Number(m[2]);
			const memBytes = (
				new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {}).exports
					.memory as WebAssembly.Memory
			).buffer.byteLength;
			if (cert.exclusions.some(([f, t]) => at < t && at + len > f)) {
				notes.push('ground2 window overlaps a second exclusion: ignored');
				g = pointerCheck(bytes, cert);
			} else if (at + len > memBytes) {
				notes.push('ground2 window lies past the initial memory, which guardInput excludes: ignored');
				g = pointerCheck(bytes, cert);
			}
		}
		return g || longCheck(bytes, cert);
	} catch (e) {
		return `harness: ${String(e).slice(0, 150)}`;
	}
}

export function evaluate(rec: Rec, heavy = false, partial?: (r: Row) => void): Row {
	const t0 = Date.now();
	const bytes = new Uint8Array(readFileSync(rec.file));
	const entry = rec.entry ?? 'update';
	const row: Row = {
		id: rec.id,
		family: rec.family,
		sha256: sha(bytes),
		checker: 'refused',
		kind: 'ok',
		ms: 0,
		note: rec.note
	};
	try {
		new WebAssembly.Module(Uint8Array.from(bytes));
	} catch {
		row.checker = 'bad-module';
		row.kind = 'bad-module';
		return row;
	}
	let cert: ReturnType<typeof certifyStream>;
	try {
		cert = certifyStream(bytes, entry);
	} catch (e) {
		row.checker = 'RAW';
		row.reason = String((e as Error).stack ?? e).slice(0, 400);
		row.kind = 'raw-checker';
		row.ms = Date.now() - t0;
		return row;
	}
	if (cert.kind === 'refusal') {
		row.checker = 'refused';
		row.reason = norm(cert.reason);
		row.kind = 'refused';
	} else {
		row.checker = 'accepted';
		row.ring = cert.ring;
		row.output = !!cert.output;
		const v = verifyCertificate(bytes, cert, VOPT);
		row.verifier = v.ok ? 'accepts' : v.reason.startsWith('internal:') ? 'RAW' : 'rejects';
		if (!v.ok) row.vreason = v.reason.slice(0, 200);
		partial?.({ ...row, kind: 'ACCEPTED-GROUND-HANG' });
		const notes: string[] = [];
		row.ground = truth(bytes, cert, heavy, notes);
		row.long = true;
		if (notes.length) row.note = `${row.note ?? ''} [${notes.join('; ')}]`;
		const wrong = !!row.ground;
		row.kind = wrong
			? row.verifier === 'accepts'
				? 'FALSE-CERT-BOTH-ACCEPT'
				: 'FALSE-CERT'
			: row.verifier === 'accepts'
				? 'accepted-correct'
				: row.verifier === 'RAW'
					? 'raw-verifier'
					: 'DISAGREE-verifier-rejects-correct';
	}
	if (rec.base) {
		partial?.({ ...row, kind: row.checker === 'refused' ? 'BORROWED-HANG-AFTER-REFUSAL' : row.kind });
		const bc = baseCert(rec.base, entry);
		if (bc) {
			const patched = { ...bc, moduleSha256: row.sha256 } as StreamCertificate;
			const v = verifyCertificate(bytes, patched, VOPT);
			if (!v.ok) {
				row.borrowed = 'verifier-rejects';
				if (v.reason.startsWith('internal:')) {
					row.kind = 'raw-verifier';
					row.vreason = v.reason.slice(0, 200);
				}
			} else {
				row.borrowed = 'verifier-accepts';
				// when the checker accepted the module with the same claim there is nothing new to run
				const same =
					row.checker === 'accepted' &&
					(cert as StreamCertificate).ring === patched.ring &&
					JSON.stringify((cert as StreamCertificate).model, (_k, x) => (typeof x === 'bigint' ? `${x}` : x)) ===
						JSON.stringify(patched.model, (_k, x) => (typeof x === 'bigint' ? `${x}` : x));
				if (!same) {
					partial?.({ ...row, kind: 'BORROWED-GROUND-HANG' });
					const g = truth(bytes, patched, false, []);
					row.bground = g;
					if (g) row.kind = 'FALSE-ACCEPT-VERIFIER';
				}
			}
		} else row.borrowed = '-';
	}
	row.ms = Date.now() - t0;
	return row;
}
