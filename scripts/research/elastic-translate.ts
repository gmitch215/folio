import type binaryenTyped from 'binaryen';
import { analyzeElision, type ElideSite } from './elastic-elide.ts';
import { MISS_ENTRY } from './elastic-translate-host.ts';
import { binaryen, children, type Setter } from './elastic-walk.ts';

export * from './elastic-translate-host.ts';

const LAST_BYTE_OF_PAGE = 0x10000;
// the last page of a 4 GiB space, which a 32-bit memory cannot hold
const CACHE_EMPTY = -LAST_BYTE_OF_PAGE;

export interface TranslateOptions {
	/** `call` sends every checked access through one shared helper, `inline` expands the lookup */
	shape?: 'call' | 'inline';
	/** leave stack-derived and static-address accesses untranslated */
	exempt?: boolean;
	/** lift lookups of loop-invariant bases out of call-free innermost loops */
	hoist?: boolean;
	/** skip the page-crossing check where the align immediate is at least the access width */
	trustAlign?: boolean;
	/** add a counter per access class, exported as `__folio_n_<class>`, and `__folio_n_miss` */
	count?: boolean;
	/** keep the last page base and delta per function (locals) or per site (globals) */
	cache?: 'function' | 'site';
	/** ranges the host keeps resident and identity-mapped; an access wholly inside one skips the table */
	arenas?: { lo: number; size: number }[];
	/** census arm: count each checked access in its own i32 slot at `base` and leave it untranslated */
	census?: { base: number; sites: CensusSite[] };
	/** one lookup per run of accesses off one pointer when nothing between them can run the pager */
	groups?: boolean;
	/** cost floor: no access is checked, so only the rest of the pass (stack bound, module size) remains */
	floor?: boolean;
	/** address of the 65,536-entry i32 table inside linear memory */
	tableBase: number;
	/** constant addresses below this stay untranslated when `exempt` is set */
	staticLimit?: number;
	/** lowest stack pointer value the pinned stack window allows when `exempt` is set */
	stackFloor?: number;
}

export type CensusSite = Omit<ElideSite, 'expr'> & { id: number; fn: number };

export interface TranslateStats {
	loads: number;
	stores: number;
	sites: Record<'stack' | 'static' | 'hoisted' | 'checked', number>;
	prologueChecks: number;
	hoistedLoops: number;
	hoistedKeys: number;
	cacheSites: number;
	arenaSites: number;
	groupSites: number;
	bytesIn: number;
	bytesOut: number;
}

export class TranslateRefusal extends Error {
	reasons: string[];
	constructor(reasons: string[]) {
		super(`folio.translate refuses this module: ${reasons.join('; ')}`);
		this.name = 'TranslateRefusal';
		this.reasons = reasons;
	}
}

const i32 = binaryen.i32;
type Class = 'stack' | 'static' | 'hoisted' | 'checked';

interface Key {
	base: number;
	add: number;
	offset: number;
	bytes: number;
	straddle: boolean;
	local: number;
}

/**
 * Rewrites every load and store of a module with an imported memory so the address goes through a
 * 64 KiB page table that lives in that memory at `tableBase`: one i32 per page holding the frame's
 * delta (frame base minus page base, a multiple of 64 KiB) or -1 for a page that is not resident.
 * The access keeps its own align and offset immediates and is applied to `ptr + delta`.
 */
export function translate(input: Uint8Array, options: TranslateOptions) {
	const shape = options.shape ?? 'inline';
	const tableBase = options.tableBase;
	const stats: TranslateStats = {
		loads: 0,
		stores: 0,
		sites: { stack: 0, static: 0, hoisted: 0, checked: 0 },
		prologueChecks: 0,
		hoistedLoops: 0,
		hoistedKeys: 0,
		cacheSites: 0,
		arenaSites: 0,
		groupSites: 0,
		bytesIn: input.length,
		bytesOut: 0
	};
	const mod = binaryen.readBinary(input);
	// Features.All also turns on compact imports, which V8 rejects
	mod.setFeatures(
		binaryen.Features.MVP |
			binaryen.Features.MutableGlobals |
			binaryen.Features.SignExt |
			binaryen.Features.NontrappingFPToInt |
			binaryen.Features.BulkMemory |
			binaryen.Features.Multivalue |
			binaryen.Features.ReferenceTypes
	);
	try {
		return run(mod, options, shape, tableBase, stats);
	} finally {
		mod.dispose();
	}
}

function run(
	mod: binaryenTyped.Module,
	options: TranslateOptions,
	shape: 'call' | 'inline',
	tableBase: number,
	stats: TranslateStats
) {
	const unknown = new Set<string>();
	if (options.groups && (shape === 'call' || options.cache || options.arenas || options.census))
		throw new TypeError(
			'folio.translate: groups needs the inline shape and no cache, arenas or census'
		);
	if (mod.getNumGlobals() === 0) throw new TranslateRefusal(['no stack pointer global']);
	const spName = binaryen.getGlobalInfo(mod.getGlobalByIndex(0)).name;
	const staticLimit = options.staticLimit ?? 0;
	const stackFloor = options.stackFloor ?? 0;
	const exempt = !!options.exempt;
	const arenas = options.arenas ?? [];
	let siteCount = 0;
	const imports = { slow: 'folio_slow', stackMiss: 'folio_stack_miss' };
	mod.addFunctionImport(imports.slow, 'folio', 'slow', binaryen.createType([i32, i32, i32]), i32);
	mod.addFunctionImport(
		imports.stackMiss,
		'folio',
		'stack_miss',
		binaryen.createType([i32]),
		binaryen.none
	);
	const counters: Record<string, string> = {};
	if (options.count)
		for (const cls of ['stack', 'static', 'hoisted', 'checked', 'miss', 'member']) {
			counters[cls] = `__folio_n_${cls}`;
			mod.addGlobal(counters[cls]!, i32, true, mod.i32.const(0));
			mod.addGlobalExport(counters[cls]!, counters[cls]!);
		}

	const tableLoad = (a: () => number) =>
		mod.i32.load(
			tableBase,
			4,
			mod.i32.and(mod.i32.shr_u(a(), mod.i32.const(14)), mod.i32.const(0x3fffc))
		);
	const slowCall = (p: () => number, o: number, bytes: number) =>
		mod.call(imports.slow, [p(), mod.i32.const(o), mod.i32.const(bytes)], i32);

	if (shape === 'call') {
		// (p, o, n) -> p + delta, the lookup of the inline form with o and n as arguments
		const get = (k: number) => mod.local.get(k, i32);
		const body = mod.block(
			null,
			[
				mod.local.set(3, mod.i32.add(get(0), get(1))),
				mod.local.set(
					4,
					tableLoad(() => get(3))
				),
				mod.if(
					mod.i32.or(
						mod.i32.or(
							mod.i32.eq(get(4), mod.i32.const(MISS_ENTRY)),
							mod.i32.lt_u(get(3), get(0))
						),
						mod.i32.gt_u(
							mod.i32.and(get(3), mod.i32.const(0xffff)),
							mod.i32.sub(mod.i32.const(LAST_BYTE_OF_PAGE), get(2))
						)
					),
					mod.local.set(4, mod.call(imports.slow, [get(0), get(1), get(2)], i32))
				),
				mod.i32.add(get(0), get(4))
			],
			i32
		);
		mod.addFunction('folio_xl', binaryen.createType([i32, i32, i32]), i32, [i32, i32], body);
	}

	const spValue = (e: number): boolean =>
		binaryen.getExpressionId(e) === binaryen.GlobalGetId &&
		binaryen.GlobalGet.getName(e) === spName;
	const constOf = (e: number): number | undefined =>
		binaryen.getExpressionId(e) === binaryen.ConstId && binaryen.getExpressionType(e) === i32
			? binaryen.Const.getValueI32(e)
			: undefined;

	const numFunctions = mod.getNumFunctions();
	for (let index = 0; index < numFunctions; index++) {
		const fn = mod.getFunctionByIndex(index);
		const body = binaryen.Function.getBody(fn);
		if (!body) continue;
		const fname = binaryen.Function.getName(fn);
		if (fname === 'folio_xl') continue;
		const numParams = binaryen.expandType(binaryen.Function.getParams(fn)).length;

		// locals whose every assignment is the stack pointer plus or minus a constant
		const stackLocals = new Set<number>();
		if (exempt) {
			const assigns: [number, number][] = [];
			const gather = (e: number) => {
				const id = binaryen.getExpressionId(e);
				if (id === binaryen.LocalSetId)
					assigns.push([binaryen.LocalSet.getIndex(e), binaryen.LocalSet.getValue(e)]);
				children(e, id, (c) => gather(c), unknown);
			};
			gather(body);
			const params = new Set<number>();
			for (let k = 0; k < numParams; k++) params.add(k);
			const derived = (e: number): boolean => {
				const id = binaryen.getExpressionId(e);
				if (spValue(e)) return true;
				if (id === binaryen.LocalGetId)
					return stackLocals.has(binaryen.LocalGet.getIndex(e));
				if (id === binaryen.LocalSetId) return derived(binaryen.LocalSet.getValue(e));
				if (id === binaryen.BinaryId) {
					const op = binaryen.Binary.getOp(e);
					const left = binaryen.Binary.getLeft(e);
					const right = binaryen.Binary.getRight(e);
					if (op === binaryen.AddInt32 || op === binaryen.SubInt32)
						return derived(left) && constOf(right) !== undefined;
				}
				return false;
			};
			const candidates = new Set<number>(
				assigns.map((x) => x[0]).filter((k) => !params.has(k))
			);
			for (;;) {
				let changed = false;
				for (const k of candidates) {
					if (stackLocals.has(k)) continue;
					if (assigns.filter((x) => x[0] === k).every((x) => derived(x[1]))) {
						stackLocals.add(k);
						changed = true;
					}
				}
				if (!changed) break;
			}
		}

		const isStackPtr = (e: number): boolean => {
			if (spValue(e)) return true;
			const id = binaryen.getExpressionId(e);
			if (id === binaryen.LocalGetId) return stackLocals.has(binaryen.LocalGet.getIndex(e));
			if (id === binaryen.BinaryId) {
				const op = binaryen.Binary.getOp(e);
				if (op === binaryen.AddInt32 || op === binaryen.SubInt32)
					return (
						isStackPtr(binaryen.Binary.getLeft(e)) &&
						constOf(binaryen.Binary.getRight(e)) !== undefined
					);
			}
			return false;
		};

		let fnCache = false;
		const vars = new Map<string, number>();
		const named = (name: string, type: number) => {
			const k = `${name}:${type}`;
			if (!vars.has(k)) vars.set(k, binaryen._BinaryenFunctionAddVar(fn, type));
			return vars.get(k)!;
		};
		const P = () => named('p', i32);
		const A = () => named('a', i32);
		const E = () => named('e', i32);
		const get = (k: number, type = i32) => mod.local.get(k, type);

		// the lookup of the address held in local P, offset o, into local `dest`
		const lookup = (
			o: number,
			bytes: number,
			straddle: boolean,
			dest: number,
			pLocal: number
		): number[] => {
			const out: number[] = [];
			let a: () => number = () => get(pLocal);
			if (o !== 0) {
				const aLocal = A();
				out.push(mod.local.set(aLocal, mod.i32.add(get(pLocal), mod.i32.const(o))));
				a = () => get(aLocal);
			}
			// one test for a missing page, an address that wrapped past 4 GiB and a page crossing
			let slow = mod.i32.eq(get(dest), mod.i32.const(MISS_ENTRY));
			if (o !== 0) slow = mod.i32.or(slow, mod.i32.lt_u(a(), get(pLocal)));
			if (straddle)
				slow = mod.i32.or(
					slow,
					mod.i32.gt_u(
						mod.i32.and(a(), mod.i32.const(0xffff)),
						mod.i32.const(LAST_BYTE_OF_PAGE - bytes)
					)
				);
			out.push(mod.local.set(dest, tableLoad(a)));
			out.push(
				mod.if(
					slow,
					mod.local.set(
						dest,
						slowCall(() => get(pLocal), o, bytes)
					)
				)
			);
			return out;
		};

		const needsStraddle = (bytes: number, align: number) =>
			bytes > 1 && !(options.trustAlign && align >= bytes);

		const missCount = (): number[] =>
			options.count
				? [
						mod.global.set(
							counters.miss!,
							mod.i32.add(mod.global.get(counters.miss!, i32), mod.i32.const(1))
						)
					]
				: [];

		// the table path, behind a one-entry cache when the site can use one
		const tablePath = (p: number, o: number, bytes: number, align: number): number => {
			const straddle = needsStraddle(bytes, align);
			// a hit needs p and p + o inside the cached page, so no wrapped sum can hit
			const window = LAST_BYTE_OF_PAGE + 1 - bytes - o;
			if (!options.cache || window < 1) {
				const e = E();
				return mod.block(
					null,
					[...lookup(o, bytes, straddle, e, p), mod.i32.add(get(p), get(e))],
					i32
				);
			}
			stats.cacheSites++;
			let base: () => number;
			let delta: () => number;
			let save: (page: number) => number[];
			let dest: number;
			if (options.cache === 'function') {
				fnCache = true;
				const cb = named('cb', i32);
				const cd = named('cd', i32);
				base = () => get(cb);
				delta = () => get(cd);
				dest = cd;
				save = (page) => [mod.local.set(cb, page)];
			} else {
				const gb = `__folio_cb${siteCount}`;
				const gd = `__folio_cd${siteCount++}`;
				mod.addGlobal(gb, i32, true, mod.i32.const(CACHE_EMPTY));
				mod.addGlobal(gd, i32, true, mod.i32.const(0));
				base = () => mod.global.get(gb, i32);
				delta = () => mod.global.get(gd, i32);
				dest = E();
				save = (page) => [mod.global.set(gb, page), mod.global.set(gd, get(dest))];
			}
			const page = o !== 0 ? get(A()) : get(p);
			return mod.block(
				null,
				[
					mod.if(
						mod.i32.ge_u(mod.i32.sub(get(p), base()), mod.i32.const(window)),
						mod.block(null, [
							...lookup(o, bytes, straddle, dest, p),
							...save(mod.i32.and(page, mod.i32.const(-LAST_BYTE_OF_PAGE))),
							...missCount()
						])
					),
					mod.i32.add(get(p), delta())
				],
				i32
			);
		};

		const translated = (ptr: number, o: number, bytes: number, align: number): number => {
			if (shape === 'call')
				return mod.call('folio_xl', [ptr, mod.i32.const(o), mod.i32.const(bytes)], i32);
			// a pointer that is already a local is used where it is
			const direct =
				binaryen.getExpressionId(ptr) === binaryen.LocalGetId
					? binaryen.LocalGet.getIndex(ptr)
					: undefined;
			const p = direct ?? P();
			const set = direct === undefined ? [mod.local.set(p, ptr)] : [];
			// an arena hit leaves the address as it is; o below lo keeps a wrapped sum out
			let outside: number | undefined;
			for (const { lo, size } of arenas) {
				if (o >= lo) continue;
				const out = mod.i32.ge_u(
					mod.i32.add(get(p), mod.i32.const((o - lo) | 0)),
					mod.i32.const((size - bytes + 1) | 0)
				);
				outside = outside === undefined ? out : mod.i32.and(outside, out);
			}
			if (outside === undefined)
				return mod.block(null, [...set, tablePath(p, o, bytes, align)], i32);
			stats.arenaSites++;
			const miss = mod.block(
				null,
				[...(options.cache ? [] : missCount()), tablePath(p, o, bytes, align)],
				i32
			);
			return mod.block(null, [...set, mod.if(outside, miss, get(p))], i32);
		};

		const counted = (cls: Class | 'member', ptr: number): number => {
			if (!options.count) return ptr;
			const name = counters[cls]!;
			return mod.block(
				null,
				[
					mod.global.set(name, mod.i32.add(mod.global.get(name, i32), mod.i32.const(1))),
					ptr
				],
				i32
			);
		};

		const census = options.census;
		let analysis = new Map<number, ElideSite>();
		const siteOf = (e: number) => {
			const site = options.groups ? analysis.get(e) : undefined;
			return site && site.shape !== 'other' ? site : undefined;
		};
		const groupDelta = new Map<ElideSite, number>();
		const groupTranslated = (site: ElideSite, ptr: number): number => {
			if (site.sound === 'member') {
				const gd = groupDelta.get(site.lead!);
				if (gd === undefined)
					throw new Error(`folio.translate: group member before its leader in ${fname}`);
				stats.groupSites++;
				return counted('member', mod.i32.add(ptr, get(gd)));
			}
			const direct =
				binaryen.getExpressionId(ptr) === binaryen.LocalGetId
					? binaryen.LocalGet.getIndex(ptr)
					: undefined;
			const p = direct ?? P();
			const set = direct === undefined ? [mod.local.set(p, ptr)] : [];
			const gd = binaryen._BinaryenFunctionAddVar(fn, i32);
			groupDelta.set(site, gd);
			const span = site.hi! - site.lo!;
			return mod.block(
				null,
				[...set, ...lookup(site.lo!, span, span > 1, gd, p), mod.i32.add(get(p), get(gd))],
				i32
			);
		};
		const access = (e: number, ptr: number, o: number, bytes: number, align: number) => {
			const site = siteOf(e);
			return site ? groupTranslated(site, ptr) : translated(ptr, o, bytes, align);
		};
		const tally = (e: number, ptr: number): number => {
			const { expr, lead, ...site } = analysis.get(e)!;
			void expr;
			void lead;
			const id = census!.sites.length;
			census!.sites.push({ ...site, id, fn: index });
			const slot = mod.i32.const(census!.base + 4 * id);
			return mod.block(
				null,
				[
					mod.i32.store(
						0,
						4,
						slot,
						mod.i32.add(
							mod.i32.load(0, 4, mod.i32.const(census!.base + 4 * id)),
							mod.i32.const(1)
						)
					),
					ptr
				],
				i32
			);
		};

		interface Plan {
			keys: Map<string, Key>;
		}
		let plan: Plan | undefined;

		const keyOf = (ptr: number, o: number) => {
			const id = binaryen.getExpressionId(ptr);
			if (id === binaryen.LocalGetId)
				return { base: binaryen.LocalGet.getIndex(ptr), add: 0, o };
			if (id === binaryen.BinaryId && binaryen.Binary.getOp(ptr) === binaryen.AddInt32) {
				const left = binaryen.Binary.getLeft(ptr);
				const c = constOf(binaryen.Binary.getRight(ptr));
				if (binaryen.getExpressionId(left) === binaryen.LocalGetId && c !== undefined)
					return { base: binaryen.LocalGet.getIndex(left), add: c, o };
			}
			return undefined;
		};

		const classify = (ptr: number, o: number, bytes: number): Class => {
			if (options.floor) return 'static';
			if (exempt) {
				const c = constOf(ptr);
				if (c !== undefined && (c >>> 0) + o + bytes <= staticLimit) return 'static';
				if (o < 65536 && isStackPtr(ptr)) return 'stack';
			}
			if (plan) {
				const k = keyOf(ptr, o);
				if (k && plan.keys.has(`${k.base}:${k.add}:${k.o}`)) return 'hoisted';
			}
			return 'checked';
		};

		const analyzeLoop = (loop: number): Plan | undefined => {
			const written = new Set<number>();
			const sites: { ptr: number; o: number; bytes: number; align: number; e: number }[] = [];
			let ok = true;
			const scan = (e: number) => {
				if (!ok) return;
				const id = binaryen.getExpressionId(e);
				if (id === binaryen.LoopId && e !== loop) ok = false;
				else if (
					id === binaryen.CallId ||
					id === binaryen.CallIndirectId ||
					id === binaryen.MemoryGrowId
				)
					ok = false;
				else if (id === binaryen.LocalSetId) written.add(binaryen.LocalSet.getIndex(e));
				else if (id === binaryen.LoadId)
					sites.push({
						e,
						ptr: binaryen.Load.getPtr(e),
						o: binaryen.Load.getOffset(e),
						bytes: binaryen.Load.getBytes(e),
						align: binaryen.Load.getAlign(e)
					});
				else if (id === binaryen.StoreId)
					sites.push({
						e,
						ptr: binaryen.Store.getPtr(e),
						o: binaryen.Store.getOffset(e),
						bytes: binaryen.Store.getBytes(e),
						align: binaryen.Store.getAlign(e)
					});
				children(e, id, (c) => scan(c), unknown);
			};
			scan(loop);
			if (!ok) return undefined;
			const keys = new Map<string, Key>();
			for (const s of sites) {
				if (binaryen.getExpressionType(s.ptr) === binaryen.unreachable) return undefined;
				if (s.bytes > 8) return undefined;
				if (exempt) {
					const c = constOf(s.ptr);
					if (c !== undefined && (c >>> 0) + s.o + s.bytes <= staticLimit) continue;
					if (s.o < 65536 && isStackPtr(s.ptr)) continue;
				}
				const k = keyOf(s.ptr, s.o);
				if (!k || written.has(k.base)) return undefined;
				const name = `${k.base}:${k.add}:${k.o}`;
				const prior = keys.get(name);
				const straddle = needsStraddle(s.bytes, s.align);
				if (prior) {
					prior.bytes = Math.max(prior.bytes, s.bytes);
					prior.straddle ||= straddle;
				} else
					keys.set(name, {
						base: k.base,
						add: k.add,
						offset: k.o,
						bytes: s.bytes,
						straddle,
						local: -1
					});
			}
			return keys.size ? { keys } : undefined;
		};

		const stackBound = (e: number, set: Setter) => {
			// pinned stack window: the new stack pointer must stay at or above the floor
			const value = binaryen.GlobalSet.getValue(e);
			if (binaryen.getExpressionId(value) === binaryen.BinaryId) {
				const op = binaryen.Binary.getOp(value);
				if (op === binaryen.AddInt32) return;
			}
			const t = named('sp', i32);
			binaryen.GlobalSet.setValue(e, get(t));
			stats.prologueChecks++;
			set(
				mod.block(null, [
					mod.local.set(t, value),
					mod.if(
						mod.i32.lt_u(get(t), mod.i32.const(stackFloor)),
						mod.call(imports.stackMiss, [get(t)], binaryen.none)
					),
					e
				])
			);
		};

		const rewrite = (e: number, set: Setter): number => {
			const id = binaryen.getExpressionId(e);
			if (id === binaryen.LoadId) {
				const level = rewrite(binaryen.Load.getPtr(e), (x) => binaryen.Load.setPtr(e, x));
				stats.loads++;
				const ptr = binaryen.Load.getPtr(e);
				if (
					binaryen.getExpressionType(ptr) === binaryen.unreachable ||
					binaryen.Load.isAtomic(e) ||
					binaryen.getExpressionType(e) === binaryen.v128
				) {
					if (binaryen.Load.isAtomic(e)) unknown.add('atomics');
					if (binaryen.getExpressionType(e) === binaryen.v128)
						unknown.add('simd memory access');
					return level;
				}
				const o = binaryen.Load.getOffset(e);
				const bytes = binaryen.Load.getBytes(e);
				const cls = classify(ptr, o, bytes);
				stats.sites[cls]++;
				if (census && cls === 'checked') binaryen.Load.setPtr(e, tally(e, ptr));
				else if (cls === 'checked')
					binaryen.Load.setPtr(
						e,
						counted(cls, access(e, ptr, o, bytes, binaryen.Load.getAlign(e)))
					);
				else if (cls === 'hoisted') {
					const k = keyOf(ptr, o)!;
					const key = plan!.keys.get(`${k.base}:${k.add}:${k.o}`)!;
					binaryen.Load.setPtr(e, counted(cls, mod.i32.add(ptr, get(key.local))));
				} else binaryen.Load.setPtr(e, counted(cls, ptr));
				return level;
			}
			if (id === binaryen.StoreId) {
				const ptrLevel = rewrite(binaryen.Store.getPtr(e), (x) =>
					binaryen.Store.setPtr(e, x)
				);
				const valueLevel = rewrite(binaryen.Store.getValue(e), (x) =>
					binaryen.Store.setValue(e, x)
				);
				stats.stores++;
				const ptr = binaryen.Store.getPtr(e);
				const value = binaryen.Store.getValue(e);
				const valueType = binaryen.getExpressionType(value);
				const level = Math.max(ptrLevel, valueLevel);
				if (
					binaryen.getExpressionType(ptr) === binaryen.unreachable ||
					valueType === binaryen.unreachable ||
					binaryen.Store.isAtomic(e) ||
					valueType === binaryen.v128
				) {
					if (binaryen.Store.isAtomic(e)) unknown.add('atomics');
					if (valueType === binaryen.v128) unknown.add('simd memory access');
					return level;
				}
				const o = binaryen.Store.getOffset(e);
				const bytes = binaryen.Store.getBytes(e);
				const cls = classify(ptr, o, bytes);
				stats.sites[cls]++;
				if (cls === 'stack' || cls === 'static') {
					binaryen.Store.setPtr(e, counted(cls, ptr));
					return level;
				}
				if (cls === 'hoisted') {
					const k = keyOf(ptr, o)!;
					const key = plan!.keys.get(`${k.base}:${k.add}:${k.o}`)!;
					binaryen.Store.setPtr(e, counted(cls, mod.i32.add(ptr, get(key.local))));
					return level;
				}
				if (census) {
					binaryen.Store.setPtr(e, tally(e, ptr));
					return level;
				}
				const vid = binaryen.getExpressionId(value);
				const simple =
					vid === binaryen.ConstId ||
					vid === binaryen.LocalGetId ||
					vid === binaryen.GlobalGetId;
				const align = binaryen.Store.getAlign(e);
				if (simple || siteOf(e)?.sound === 'member') {
					binaryen.Store.setPtr(e, counted(cls, access(e, ptr, o, bytes, align)));
					return level;
				}
				// translate after the value, so a miss inside the value cannot invalidate the frame
				const depth = valueLevel + 1;
				const tp = named(`sp${depth}`, i32);
				const tv = named(`sv${depth}`, valueType);
				binaryen.Store.setPtr(e, counted(cls, access(e, get(tp), o, bytes, align)));
				binaryen.Store.setValue(e, get(tv, valueType));
				set(mod.block(null, [mod.local.set(tp, ptr), mod.local.set(tv, value), e]));
				return depth;
			}
			if (id === binaryen.LoopId && options.hoist && !plan) {
				const found = analyzeLoop(e);
				if (found) {
					plan = found;
					const pre: number[] = [];
					for (const key of found.keys.values()) {
						key.local = binaryen._BinaryenFunctionAddVar(fn, i32);
						const p = P();
						const base = get(key.base);
						pre.push(
							mod.local.set(
								p,
								key.add ? mod.i32.add(base, mod.i32.const(key.add)) : base
							),
							...lookup(key.offset, key.bytes, key.straddle, key.local, p)
						);
						stats.hoistedKeys++;
					}
					stats.hoistedLoops++;
					const level = rewrite(binaryen.Loop.getBody(e), (x) =>
						binaryen.Loop.setBody(e, x)
					);
					plan = undefined;
					set(mod.block(null, [...pre, e], binaryen.getExpressionType(e)));
					return level;
				}
			}
			if (id === binaryen.GlobalSetId && exempt) {
				const level = rewrite(binaryen.GlobalSet.getValue(e), (x) =>
					binaryen.GlobalSet.setValue(e, x)
				);
				if (binaryen.GlobalSet.getName(e) === spName) stackBound(e, set);
				return level;
			}
			let level = 0;
			children(e, id, (c, s) => (level = Math.max(level, rewrite(c, s))), unknown);
			return level;
		};

		if (census || options.groups)
			analysis = new Map(
				analyzeElision(
					body,
					(_e, ptr, o, bytes) => classify(ptr, o, bytes) === 'checked',
					unknown
				).map((s) => [s.expr, s])
			);
		rewrite(body, (x) => binaryen.Function.setBody(fn, x));
		if (fnCache) {
			const rewritten = binaryen.Function.getBody(fn);
			binaryen.Function.setBody(
				fn,
				mod.block(
					null,
					[mod.local.set(named('cb', i32), mod.i32.const(CACHE_EMPTY)), rewritten],
					binaryen.getExpressionType(rewritten)
				)
			);
		}
	}
	if (unknown.size) throw new TranslateRefusal([...unknown].sort());
	if (!mod.validate()) throw new TypeError('folio.translate produced an invalid module');
	const bytes = mod.emitBinary();
	stats.bytesOut = bytes.length;
	return { bytes, stats };
}
