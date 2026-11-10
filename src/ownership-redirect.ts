import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import {
	iterationRoute,
	redirectDelta,
	stackRoute,
	type IterationRoute,
	type OwnershipPlan
} from './extract.ts';
import { memoryAccesses, verifyOwnership, type OwnershipCertificate } from './ownership.ts';

export type RedirectErrorCode = 'unbound' | 'stale' | 'invalid' | 'unsupported';

export class OwnershipRedirectError extends Error {
	readonly code: RedirectErrorCode;

	constructor(code: RedirectErrorCode, detail: string) {
		super(detail);
		this.name = 'OwnershipRedirectError';
		this.code = code;
	}
}

export interface RedirectStats {
	redirected: number;
	skipped: number;
	bulk: number;
	straddle: number;
	functions: number;
}

export interface OwnershipRedirect {
	module: Uint8Array;
	plan: OwnershipPlan;
	stats: RedirectStats;
}

const i32 = binaryen.i32;
const api = binaryen as any;

interface Win {
	low: number;
	end: number;
	delta: string;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Rewrites the closure of a certified module so each window access adds a per-worker delta. The
 * delta globals start at 0, so the module still runs in place. Throws `OwnershipRedirectError`
 * when the certificate does not bind to the bytes or the module cannot be rewritten.
 */
export function redirectOwnership(
	bytes: Uint8Array,
	certificate: OwnershipCertificate
): OwnershipRedirect {
	if (certificate.kind !== 'certificate' || certificate.moduleSha256 !== sha(bytes))
		throw new OwnershipRedirectError('unbound', 'the certificate is for another module');
	if (!verifyOwnership(bytes, certificate))
		throw new OwnershipRedirectError('stale', 'the certificate does not re-derive');
	const m = binaryen.readBinary(Uint8Array.from(bytes));
	const debug = api.getDebugInfo?.() ?? false;
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		m.setFeatures(binaryen.Features.All & ~compact);
		const windows: Win[] = certificate.windows.map((w, i) => ({
			low: w.low,
			end: w.end,
			delta: `${redirectDelta}${i}`
		}));
		for (const w of windows)
			if (m.getGlobal(w.delta) || m.getExport(w.delta))
				throw new OwnershipRedirectError('unsupported', `${w.delta} is already defined`);
		for (const w of windows) {
			m.addGlobal(w.delta, i32, true, m.i32.const(0));
			m.addGlobalExport(w.delta, w.delta);
		}
		const c = (v: number) => m.i32.const(v | 0);
		const get = (index: number) => m.local.get(index, i32);
		const stats: RedirectStats = {
			redirected: 0,
			skipped: 0,
			bulk: 0,
			straddle: 0,
			functions: 0
		};
		const lowest = Math.min(...windows.map((w) => w.low));

		// the byte at `a + k` lies wholly in window w when the offset from low is below `limit`
		const inside = (a: number, k: number, w: Win, width: number) =>
			m.i32.lt_u(
				m.i32.sub(k ? m.i32.add(get(a), c(k)) : get(a), c(w.low)),
				c(w.end - w.low - width + 1)
			);
		const overlaps = (a: number, k: number, w: Win, width: number) =>
			m.i32.lt_u(
				m.i32.sub(k ? m.i32.add(get(a), c(k)) : get(a), c(w.low - width + 1)),
				c(w.end - w.low + width - 1)
			);
		const partial = (a: number, k: number, w: Win, width: number) =>
			m.i32.and(overlaps(a, k, w, width), m.i32.eqz(inside(a, k, w, width)));
		const chain = (test: (w: Win) => number) =>
			windows.reduceRight(
				(rest, w) => m.select(test(w), m.global.get(w.delta, i32), rest),
				c(0)
			);
		const any = (test: (w: Win) => number) =>
			windows.map(test).reduce((left, right) => m.i32.or(left, right));

		for (const name of certificate.functions) {
			const ref = m.getFunction(name);
			if (!ref) throw new OwnershipRedirectError('stale', `no function ${name}`);
			const body = binaryen.getFunctionInfo(ref).body;
			const sites = memoryAccesses(body);
			const modes = certificate.accesses[name] ?? '';
			if (modes.length !== sites.length)
				throw new OwnershipRedirectError('stale', `the accesses of ${name} changed`);
			const infos = sites.map((e) => ({ e, v: binaryen.getExpressionInfo(e) as any }));
			let t = -1;
			let bulk: number[] = [];
			stats.functions++;
			infos.forEach(({ e, v }, at) => {
				const mode = modes[at]!;
				if (mode === 'o') {
					stats.skipped++;
					return;
				}
				const id = binaryen.getExpressionId(e);
				if (id === binaryen.LoadId || id === binaryen.StoreId) {
					const k = Number(BigInt.asUintN(32, BigInt(v.offset)));
					if (k > lowest)
						throw new OwnershipRedirectError(
							'unsupported',
							'an access offset passes a window'
						);
					if (t < 0) t = api._BinaryenFunctionAddVar(ref, i32);
					const width: number = v.bytes;
					let delta = chain((w) => inside(t, k, w, width));
					if (width > 1 && mode !== 'x' && mode !== 'b') {
						delta = m.if(
							any((w) => partial(t, k, w, width)),
							m.unreachable(),
							delta
						);
						stats.straddle++;
					}
					const ptr = m.i32.add(m.local.tee(t, v.ptr, i32), delta);
					if (id === binaryen.LoadId) api._BinaryenLoadSetPtr(e, ptr);
					else api._BinaryenStoreSetPtr(e, ptr);
					stats.redirected++;
					return;
				}
				if (bulk.length === 0) {
					bulk = [0, 1, 2, 3].map(() => api._BinaryenFunctionAddVar(ref, i32));
				}
				const [td, ts, tn, tv] = bulk as [number, number, number, number];
				void tv;
				const isCopy = id === binaryen.MemoryCopyId;
				const dest = v.dest;
				const second = isCopy
					? v.source
					: id === binaryen.MemoryFillId
						? v.value
						: v.offset;
				const size = v.size;
				const room = (a: number) => {
					const n = (w: Win) => w.end - w.low;
					const inn = (w: Win) =>
						m.i32.and(
							m.i32.le_u(get(tn), c(n(w))),
							m.i32.le_u(m.i32.sub(get(a), c(w.low)), m.i32.sub(c(n(w)), get(tn)))
						);
					const part = (w: Win) =>
						m.i32.and(
							m.i32.and(
								m.i32.lt_u(get(a), c(w.end)),
								m.i32.gt_u(m.i32.add(get(a), get(tn)), c(w.low))
							),
							m.i32.eqz(inn(w))
						);
					const pick = windows.reduceRight(
						(rest, w) => m.select(inn(w), m.global.get(w.delta, i32), rest),
						c(0)
					);
					return m.if(any(part), m.unreachable(), pick);
				};
				const first = m.block(
					null,
					[
						m.local.set(td, dest),
						m.local.set(ts, second),
						m.local.set(tn, size),
						m.i32.add(get(td), room(td))
					],
					i32
				);
				const next = isCopy ? m.i32.add(get(ts), room(ts)) : get(ts);
				if (isCopy) {
					api._BinaryenMemoryCopySetDest(e, first);
					api._BinaryenMemoryCopySetSource(e, next);
					api._BinaryenMemoryCopySetSize(e, get(tn));
				} else if (id === binaryen.MemoryFillId) {
					api._BinaryenMemoryFillSetDest(e, first);
					api._BinaryenMemoryFillSetValue(e, next);
					api._BinaryenMemoryFillSetSize(e, get(tn));
				} else {
					api._BinaryenMemoryInitSetDest(e, first);
					api._BinaryenMemoryInitSetOffset(e, next);
					api._BinaryenMemoryInitSetSize(e, get(tn));
				}
				stats.bulk++;
				stats.straddle++;
			});
		}
		if (!m.validate())
			throw new OwnershipRedirectError('invalid', 'the redirected module is invalid');
		api.setDebugInfo?.(true);
		const out = Uint8Array.from(m.emitBinary());
		try {
			new WebAssembly.Module(out);
		} catch (error) {
			throw new OwnershipRedirectError(
				'invalid',
				`the redirected module does not compile: ${error}`
			);
		}
		return {
			module: out,
			plan: {
				windows: windows.map((w) => ({ low: w.low, end: w.end, delta: w.delta })),
				copyOut: certificate.copyOut.map(([a, b]) => [a, b] as [number, number])
			},
			stats
		};
	} finally {
		api.setDebugInfo?.(debug);
		m.dispose();
	}
}

/** The iteration route of the redirected module, with the plan the executor needs. */
export function ownershipRoute(
	bytes: Uint8Array,
	certificate: OwnershipCertificate
): { route: IterationRoute; redirect: OwnershipRedirect } {
	const redirect = redirectOwnership(bytes, certificate);
	const route = iterationRoute(redirect.module, stackRoute(redirect.module));
	if (route.eligible) route.ownership = redirect.plan;
	return { route, redirect };
}
