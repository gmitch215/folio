import binaryen from 'binaryen';
import { children } from './purity-census.ts';

const ALLOC =
	/^(malloc|free|calloc|realloc|__zend_(m|c|re)alloc|_emalloc(_\w+)?|_efree(_\w+)?|_erealloc2?|_ecalloc|_safe_\w*alloc|_zend_mm_(alloc|free|realloc2?)|gc_possible_root|gc_remove_from_buffer|zend_objects_store_put)$/;

/** the dispatch function, allocator entry points and output write path of a PHP module, by export name */
export function phpExtents(bytes: Uint8Array) {
	const m = binaryen.readBinary(bytes);
	const exported = new Map<string, string>();
	for (let i = 0; i < m.getNumExports(); i++) {
		const e = binaryen.getExportInfo(m.getExportByIndex(i));
		if (e.kind === binaryen.ExternalFunction) exported.set(e.name, e.value);
	}
	let stackHigh = 0;
	for (let i = 0; i < m.getNumGlobals(); i++) {
		const g = binaryen.getGlobalInfo(m.getGlobalByIndex(i));
		if (g.name === 'global$0') stackHigh = (binaryen.getExpressionInfo(g.init) as any).value;
	}
	m.dispose();
	return {
		dispatch: exported.get('execute_ex')!,
		alloc: [...exported].filter(([n]) => ALLOC.test(n)).map(([, v]) => v),
		out: ['php_output_write', 'php_write', 'php_output_write_unbuffered']
			.map((n) => exported.get(n))
			.filter((v): v is string => !!v),
		stackHigh
	};
}

// counters are f64 globals bumped once per straight-line chunk; the unit is binaryen IR nodes
export const COUNTERS = [
	'n',
	'ld',
	'st',
	'ldb',
	'stb',
	'call',
	'host',
	'calli',
	'spr',
	'spw'
] as const;
type Tally = number[];
const zero = (): Tally =>
	Object.assign(
		COUNTERS.map(() => 0),
		{ s: [] as number[] }
	);
const add = (a: Tally, b: Tally) => {
	for (let i = 0; i < a.length; i++) a[i]! += b[i]!;
	if ((b as any).s?.length) (a as any).s.push(...(b as any).s);
	return a;
};
const T = Object.fromEntries(COUNTERS.map((c, i) => [c, i])) as Record<
	(typeof COUNTERS)[number],
	number
>;

export type Mode = 'count' | 'trace';

export interface InstrumentOptions {
	mode: Mode;
	/** name of the interpreter dispatch function (execute_ex) */
	dispatch: string;
	/** names of functions whose dynamic extent is allocator work */
	alloc: string[];
	/** names of functions whose dynamic extent is the output write path */
	out: string[];
	/** name of the stack pointer global */
	stackGlobal?: string;
	/** trace mode also keeps every counter, to cross-check the hooks against the tallies */
	allCounters?: boolean;
	/** instrument only functions with an index in [lo, hi), for bisecting a defect */
	range?: [number, number];
	/** adds a hook at each chunk start and returns the sites each chunk contains */
	debugChunks?: boolean;
}

export interface Sites {
	/** static offset of each memory access site */
	offset: Uint32Array;
	/** bytes in bits 0-3, store in bit 4, refcount pattern in bits 5-6 (1 inc, 2 dec) */
	meta: Uint8Array;
	fn: Uint32Array;
}

const B = binaryen as any;
const F = (name: string) => {
	const fn = B[name];
	if (typeof fn !== 'function') throw new Error(`binaryen lacks ${name}`);
	return fn as (...args: any[]) => any;
};

const kinds = {
	extentEnter: 0,
	extentExit: 1
};
export const EXTENT = { alloc: 1, out: 2, exec: 3 };

export function instrumentWorksp(bytes: Uint8Array, options: InstrumentOptions) {
	const m = binaryen.readBinary(bytes);
	const trace = options.mode === 'trace';
	const i32 = binaryen.i32;
	const sp = options.stackGlobal ?? 'global$0';
	for (const c of COUNTERS) {
		m.addGlobal(`__wk_${c}`, binaryen.f64, true, m.f64.const(0));
		m.addGlobalExport(`__wk_${c}`, `__wk_${c}`);
	}
	if (trace && m.getGlobal(sp)) m.addGlobalExport(sp, '__wk_sp');
	const imp = (name: string, params: number[], result: number) =>
		m.addFunctionImport(`folio_${name}`, 'folio', name, binaryen.createType(params), result);
	imp('ed', [i32], i32);
	imp('ci', [i32, i32], i32);
	imp('mn', [i32, i32], i32);
	imp('en', [i32], binaryen.none);
	if (options.debugChunks) imp('ck', [i32], binaryen.none);
	imp('ex', [i32], binaryen.none);
	if (trace) {
		imp('ld', [i32, i32], i32);
		imp('st', [i32, i32], i32);
		imp('md', [i32], i32);
		imp('ms', [i32], i32);
	}
	const call = (name: string, args: number[], type = i32) => m.call(`folio_${name}`, args, type);
	const bump = (k: number, which: (typeof COUNTERS)[number]) =>
		m.global.set(
			`__wk_${which}`,
			m.f64.add(m.global.get(`__wk_${which}`, binaryen.f64), m.f64.const(k))
		);
	const incs = (t: Tally) => {
		const out: number[] = [];
		for (const c of COUNTERS) {
			const k = t[T[c]]!;
			if (k === 0) continue;
			if (trace && !options.allCounters && !['n', 'spr', 'spw'].includes(c)) continue;
			out.push(bump(k, c));
		}
		return out;
	};
	const chunkSites: number[][] = [];
	const chunkOps = (t: Tally) => {
		const ops = incs(t);
		if (options.debugChunks && ops.length) {
			ops.push(call('ck', [m.i32.const(chunkSites.length)], binaryen.none));
			chunkSites.push([...(t as any).s]);
		}
		return ops;
	};
	const siteOffset: number[] = [];
	const siteMeta: number[] = [];
	const siteFn: number[] = [];
	const stats = {
		unknownKinds: 0,
		unsupportedReturns: 0,
		extentFunctions: 0,
		dispatchSites: 0,
		rcInc: 0,
		rcDec: 0
	};
	const rcLoads = new Map<number, number>();
	let lastSite = -1;
	let current = {
		index: 0,
		extent: 0,
		tmp: -1,
		resultType: binaryen.none as number,
		fn: 0,
		depth: 0,
		temps: new Map<string, number>()
	};
	// a store is recorded after its value is evaluated, so a read inside the value stays upward exposed
	const temp = (depth: number, type: number, role: string) => {
		const key = `${role}${depth}:${type}`;
		let idx = current.temps.get(key);
		if (idx === undefined) {
			idx = F('_BinaryenFunctionAddVar')(current.fn, type) as number;
			current.temps.set(key, idx);
		}
		return idx;
	};

	const rcPattern = (v: any): number => {
		if (v.bytes !== 4 || v.offset !== 0) return 0;
		const ptr: any = binaryen.getExpressionInfo(v.ptr);
		if (ptr.id !== binaryen.LocalGetId) return 0;
		let val: any = binaryen.getExpressionInfo(v.value);
		if (val.id === binaryen.LocalSetId && val.isTee)
			val = binaryen.getExpressionInfo(val.value);
		if (val.id !== binaryen.BinaryId) return 0;
		const inc = val.op === binaryen.AddInt32;
		const dec = val.op === binaryen.SubInt32;
		if (!inc && !dec) return 0;
		const left: any = binaryen.getExpressionInfo(val.left);
		const right: any = binaryen.getExpressionInfo(val.right);
		if (left.id !== binaryen.LoadId || right.id !== binaryen.ConstId || right.value !== 1)
			return 0;
		if (left.bytes !== 4 || left.offset !== 0) return 0;
		const lp: any = binaryen.getExpressionInfo(left.ptr);
		if (lp.id !== binaryen.LocalGetId || lp.index !== ptr.index) return 0;
		const tag = inc ? 1 : 2;
		rcLoads.set(val.left, tag);
		return tag;
	};

	const site = (offset: number, bytes: number, store: boolean, tag: number) => {
		siteOffset.push(offset >>> 0);
		siteMeta.push((bytes & 15) | (store ? 16 : 0) | (tag << 5));
		siteFn.push(current.index);
		lastSite = siteOffset.length - 1;
		return lastSite;
	};

	// returns the shallow tally of an expression and whether control may leave it early
	function visit(e: number): { t: Tally; esc: boolean } {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.NopId) return { t: zero(), esc: false };
		if (id === binaryen.UnreachableId) {
			const t = zero();
			t[T.n] = 1;
			return { t, esc: true };
		}
		const v: any = binaryen.getExpressionInfo(e);
		const t = zero();
		t[T.n] = 1;
		let esc = false;
		let tag = 0;
		if (id === binaryen.StoreId && trace) tag = rcPattern(v);
		if (id === binaryen.BlockId) {
			if (v.children.length) esc = list(v.children, e);
			return { t, esc };
		}
		if (id === binaryen.LoopId) {
			esc = body(v.body, (b) => F('_BinaryenLoopSetBody')(e, b));
			return { t, esc };
		}
		if (id === binaryen.IfId) {
			const c = visit(v.condition);
			add(t, c.t);
			esc = c.esc;
			esc = body(v.ifTrue, (b) => F('_BinaryenIfSetIfTrue')(e, b)) || esc;
			if (v.ifFalse) esc = body(v.ifFalse, (b) => F('_BinaryenIfSetIfFalse')(e, b)) || esc;
			return { t, esc };
		}
		if (id === binaryen.StoreId) current.depth++;
		for (const child of children(v)) {
			const r = visit(child);
			add(t, r.t);
			esc ||= r.esc;
		}
		if (id === binaryen.StoreId) current.depth--;
		switch (id) {
			case binaryen.ReturnId:
				if (current.extent) stats.unsupportedReturns++;
				esc = true;
				break;
			case binaryen.BreakId:
			case binaryen.SwitchId:
				esc = true;
				break;
			case binaryen.LoadId: {
				t[T.ld]! += 1;
				t[T.ldb]! += v.bytes;
				if (trace) {
					const s = site(v.offset, v.bytes, false, rcLoads.get(e) ?? 0);
					(t as any).s.push(s);
					F('_BinaryenLoadSetPtr')(e, call('ld', [v.ptr, m.i32.const(s)]));
				}
				break;
			}
			case binaryen.StoreId: {
				t[T.st]! += 1;
				t[T.stb]! += v.bytes;
				if (tag === 1) stats.rcInc++;
				if (tag === 2) stats.rcDec++;
				if (trace) {
					const s = site(v.offset, v.bytes, true, tag);
					(t as any).s.push(s);
					const vt = binaryen.getExpressionType(v.value);
					const pt = temp(current.depth, i32, 'p');
					const vv = temp(current.depth, vt, 'v');
					F('_BinaryenStoreSetPtr')(e, m.local.tee(pt, v.ptr, i32));
					F('_BinaryenStoreSetValue')(
						e,
						m.block(
							null,
							[
								m.local.set(vv, v.value),
								m.drop(call('st', [m.local.get(pt, i32), m.i32.const(s)])),
								m.local.get(vv, vt)
							],
							vt
						)
					);
				}
				break;
			}
			case binaryen.CallId: {
				const info: any = binaryen.getFunctionInfo(m.getFunction(v.target));
				if (info.module) t[T.host]! += 1;
				else t[T.call]! += 1;
				break;
			}
			case binaryen.CallIndirectId:
				t[T.calli]! += 1;
				if (current.index >= 0 && siteIsDispatch) {
					stats.dispatchSites++;
					const ops = v.operands as number[];
					F('_BinaryenCallIndirectSetOperandAt')(e, 0, call('ed', [ops[0]!]));
					F('_BinaryenCallIndirectSetTarget')(
						e,
						call('ci', [m.i32.const(stats.dispatchSites), v.target])
					);
				}
				break;
			case binaryen.GlobalGetId:
				if (v.name === sp) t[T.spr]! += 1;
				break;
			case binaryen.GlobalSetId:
				if (v.name === sp) t[T.spw]! += 1;
				break;
			case binaryen.MemoryCopyId:
				if (trace) {
					F('_BinaryenMemoryCopySetDest')(e, call('md', [v.dest]));
					F('_BinaryenMemoryCopySetSource')(e, call('ms', [v.source]));
				}
				F('_BinaryenMemoryCopySetSize')(e, call('mn', [v.size, m.i32.const(0)]));
				break;
			case binaryen.MemoryFillId:
				if (trace) F('_BinaryenMemoryFillSetDest')(e, call('md', [v.dest]));
				F('_BinaryenMemoryFillSetSize')(e, call('mn', [v.size, m.i32.const(1)]));
				break;
			case binaryen.MemoryInitId:
				if (trace) F('_BinaryenMemoryInitSetDest')(e, call('md', [v.dest]));
				F('_BinaryenMemoryInitSetSize')(e, call('mn', [v.size, m.i32.const(2)]));
				break;
			default:
				if (!KNOWN.has(id)) stats.unknownKinds++;
		}
		return { t, esc };
	}

	// replaces a Return with exit-hook code when the function is an extent function
	function rewriteReturn(e: number): { expr: number; t: Tally } {
		const v: any = binaryen.getExpressionInfo(e);
		const r = v.value ? visit(v.value) : { t: zero(), esc: false };
		const t = add(r.t, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		const stmts: number[] = [];
		const exit = () => call('ex', [m.i32.const(current.extent)], binaryen.none);
		if (v.value && current.tmp >= 0) {
			stmts.push(m.local.set(current.tmp, v.value), exit());
			stmts.push(m.return(m.local.get(current.tmp, current.resultType)));
		} else stmts.push(exit(), m.return(v.value));
		return { expr: m.block(null, stmts, binaryen.unreachable), t };
	}

	// handles a block's child list: chunks of straight-line code get one counter bump each
	function list(items: number[], block: number): boolean {
		const results: { t: Tally; esc: boolean }[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			if (current.extent && binaryen.getExpressionId(item) === binaryen.ReturnId) {
				const r = rewriteReturn(item);
				F('_BinaryenBlockSetChildAt')(block, i, r.expr);
				results.push({ t: r.t, esc: true });
				continue;
			}
			results.push(visit(item));
		}
		const plans: { at: number; t: Tally }[] = [];
		let acc = zero();
		let start = 0;
		let esc = false;
		for (let i = 0; i < results.length; i++) {
			add(acc, results[i]!.t);
			if (results[i]!.esc) {
				esc = true;
				plans.push({ at: start, t: acc });
				acc = zero();
				start = i + 1;
			}
		}
		if (start < items.length) plans.push({ at: start, t: acc });
		for (const plan of plans.reverse()) {
			const ops = chunkOps(plan.t);
			for (let k = ops.length - 1; k >= 0; k--)
				F('_BinaryenBlockInsertChildAt')(block, plan.at, ops[k]);
		}
		return esc;
	}

	// handles a single expression used as a body (loop body, if arm, function body)
	function body(e: number, set: (b: number) => void): boolean {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.BlockId) {
			const v: any = binaryen.getExpressionInfo(e);
			return v.children.length ? list(v.children, e) : false;
		}
		if (current.extent && id === binaryen.ReturnId) {
			const r = rewriteReturn(e);
			set(m.block(null, [...incs(r.t), r.expr], binaryen.unreachable));
			return true;
		}
		const r = visit(e);
		const ops = chunkOps(r.t);
		if (ops.length) {
			set(m.block(null, [...ops, e], binaryen.getExpressionType(e)));
		}
		return r.esc;
	}

	const allocSet = new Set(options.alloc);
	const outSet = new Set(options.out);
	let siteIsDispatch = false;
	for (let i = 0; i < m.getNumFunctions(); i++) {
		const fn = m.getFunctionByIndex(i);
		const info: any = binaryen.getFunctionInfo(fn);
		if (!info.body) continue;
		if (options.range && (i < options.range[0] || i >= options.range[1])) continue;
		const extent = allocSet.has(info.name)
			? EXTENT.alloc
			: outSet.has(info.name)
				? EXTENT.out
				: info.name === options.dispatch
					? EXTENT.exec
					: 0;
		const results = binaryen.expandType(info.results);
		current = {
			index: i,
			extent,
			tmp: extent && results.length === 1 ? F('_BinaryenFunctionAddVar')(fn, results[0]) : -1,
			resultType: (results[0] as number) ?? binaryen.none,
			fn,
			depth: 0,
			temps: new Map<string, number>()
		};
		siteIsDispatch = info.name === options.dispatch;
		const set = (b: number) => F('_BinaryenFunctionSetBody')(fn, b);
		body(info.body, set);
		if (extent) {
			stats.extentFunctions++;
			const entry = call('en', [m.i32.const(extent)], binaryen.none);
			const exit = call('ex', [m.i32.const(extent)], binaryen.none);
			const original = binaryen.getFunctionInfo(fn).body;
			const wrapped =
				current.tmp >= 0
					? m.block(
							null,
							[
								entry,
								m.local.set(current.tmp, original),
								exit,
								m.local.get(current.tmp, current.resultType)
							],
							current.resultType
						)
					: m.block(null, [entry, original, exit], binaryen.none);
			set(wrapped);
		}
	}
	void kinds;
	const out = new Uint8Array(m.emitBinary());
	m.dispose();
	try {
		new WebAssembly.Module(out);
	} catch (error) {
		throw new Error(`instrumented bytes do not validate: ${error}`);
	}
	const sites: Sites & { chunkSites?: number[][] } = {
		chunkSites: options.debugChunks ? chunkSites : undefined,
		offset: Uint32Array.from(siteOffset),
		meta: Uint8Array.from(siteMeta),
		fn: Uint32Array.from(siteFn)
	};
	return { bytes: out, sites, stats };
}

const KNOWN = new Set<number>([
	binaryen.LocalGetId,
	binaryen.LocalSetId,
	binaryen.ConstId,
	binaryen.UnaryId,
	binaryen.BinaryId,
	binaryen.SelectId,
	binaryen.DropId,
	binaryen.MemoryGrowId,
	binaryen.MemorySizeId,
	binaryen.DataDropId,
	binaryen.TableSizeId
]);
