import binaryenTyped from 'binaryen';
import { MISS_ENTRY } from './elastic-translate-host.ts';

export * from './elastic-translate-host.ts';

const LAST_BYTE_OF_PAGE = 0x10000;
// the last page of a 4 GiB space, which a 32-bit memory cannot hold
const CACHE_EMPTY = -LAST_BYTE_OF_PAGE;
// the package typings omit the expression namespaces and the C entry points this pass uses
const binaryen: any = binaryenTyped;

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
	/** address of the 65,536-entry i32 table inside linear memory */
	tableBase: number;
	/** constant addresses below this stay untranslated when `exempt` is set */
	staticLimit?: number;
	/** lowest stack pointer value the pinned stack window allows when `exempt` is set */
	stackFloor?: number;
	/** group checked accesses by base local: one residency check per group, a global epoch re-check after calls */
	epoch?: boolean;
	/** address of the i32 epoch word, default one entry past the table */
	epochAddr?: number;
	/** widest byte span one group check may cover */
	maxSpan?: number;
}

export interface TranslateStats {
	loads: number;
	stores: number;
	sites: Record<'stack' | 'static' | 'hoisted' | 'checked' | 'group', number>;
	groups: number;
	groupMembers: number;
	groupSingletonsDropped: number;
	groupReasons: Record<string, number>;
	epochSites: number;
	prologueChecks: number;
	hoistedLoops: number;
	hoistedKeys: number;
	cacheSites: number;
	arenaSites: number;
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
const refused: Record<number, string> = {
	[binaryen.AtomicRMWId]: 'atomics',
	[binaryen.AtomicCmpxchgId]: 'atomics',
	[binaryen.AtomicWaitId]: 'atomics',
	[binaryen.AtomicNotifyId]: 'atomics',
	[binaryen.AtomicFenceId]: 'atomics',
	[binaryen.MemoryCopyId]: 'memory.copy',
	[binaryen.MemoryFillId]: 'memory.fill',
	[binaryen.MemoryInitId]: 'memory.init',
	[binaryen.SIMDLoadId]: 'simd memory access',
	[binaryen.SIMDLoadStoreLaneId]: 'simd memory access',
	[binaryen.TryId]: 'exception handling'
};
const leaves = new Set<number>([
	binaryen.ConstId,
	binaryen.LocalGetId,
	binaryen.GlobalGetId,
	binaryen.MemorySizeId,
	binaryen.NopId,
	binaryen.UnreachableId,
	binaryen.RefFuncId,
	binaryen.DataDropId
]);

type Setter = (expression: number) => void;
type Visit = (child: number, set: Setter) => void;

// every expression kind the walk knows; anything else is recorded and refused
function children(e: number, id: number, visit: Visit, unknown: Set<string>) {
	switch (id) {
		case binaryen.BlockId:
			for (let k = 0, n = binaryen.Block.getNumChildren(e); k < n; k++)
				visit(binaryen.Block.getChildAt(e, k), (x) => binaryen.Block.setChildAt(e, k, x));
			return;
		case binaryen.IfId:
			visit(binaryen.If.getCondition(e), (x) => binaryen.If.setCondition(e, x));
			visit(binaryen.If.getIfTrue(e), (x) => binaryen.If.setIfTrue(e, x));
			if (binaryen.If.getIfFalse(e))
				visit(binaryen.If.getIfFalse(e), (x) => binaryen.If.setIfFalse(e, x));
			return;
		case binaryen.LoopId:
			visit(binaryen.Loop.getBody(e), (x) => binaryen.Loop.setBody(e, x));
			return;
		case binaryen.BreakId:
			if (binaryen.Break.getCondition(e))
				visit(binaryen.Break.getCondition(e), (x) => binaryen.Break.setCondition(e, x));
			if (binaryen.Break.getValue(e))
				visit(binaryen.Break.getValue(e), (x) => binaryen.Break.setValue(e, x));
			return;
		case binaryen.SwitchId:
			visit(binaryen.Switch.getCondition(e), (x) => binaryen.Switch.setCondition(e, x));
			if (binaryen.Switch.getValue(e))
				visit(binaryen.Switch.getValue(e), (x) => binaryen.Switch.setValue(e, x));
			return;
		case binaryen.CallId:
			for (let k = 0, n = binaryen.Call.getNumOperands(e); k < n; k++)
				visit(binaryen.Call.getOperandAt(e, k), (x) => binaryen.Call.setOperandAt(e, k, x));
			return;
		case binaryen.CallIndirectId:
			visit(binaryen.CallIndirect.getTarget(e), (x) => binaryen.CallIndirect.setTarget(e, x));
			for (let k = 0, n = binaryen.CallIndirect.getNumOperands(e); k < n; k++)
				visit(binaryen.CallIndirect.getOperandAt(e, k), (x) =>
					binaryen.CallIndirect.setOperandAt(e, k, x)
				);
			return;
		case binaryen.LocalSetId:
			visit(binaryen.LocalSet.getValue(e), (x) => binaryen.LocalSet.setValue(e, x));
			return;
		case binaryen.GlobalSetId:
			visit(binaryen.GlobalSet.getValue(e), (x) => binaryen.GlobalSet.setValue(e, x));
			return;
		case binaryen.LoadId:
			visit(binaryen.Load.getPtr(e), (x) => binaryen.Load.setPtr(e, x));
			return;
		case binaryen.StoreId:
			visit(binaryen.Store.getPtr(e), (x) => binaryen.Store.setPtr(e, x));
			visit(binaryen.Store.getValue(e), (x) => binaryen.Store.setValue(e, x));
			return;
		case binaryen.UnaryId:
			visit(binaryen.Unary.getValue(e), (x) => binaryen.Unary.setValue(e, x));
			return;
		case binaryen.BinaryId:
			visit(binaryen.Binary.getLeft(e), (x) => binaryen.Binary.setLeft(e, x));
			visit(binaryen.Binary.getRight(e), (x) => binaryen.Binary.setRight(e, x));
			return;
		case binaryen.SelectId:
			visit(binaryen.Select.getIfTrue(e), (x) => binaryen.Select.setIfTrue(e, x));
			visit(binaryen.Select.getIfFalse(e), (x) => binaryen.Select.setIfFalse(e, x));
			visit(binaryen.Select.getCondition(e), (x) => binaryen.Select.setCondition(e, x));
			return;
		case binaryen.DropId:
			visit(binaryen.Drop.getValue(e), (x) => binaryen.Drop.setValue(e, x));
			return;
		case binaryen.ReturnId:
			if (binaryen.Return.getValue(e))
				visit(binaryen.Return.getValue(e), (x) => binaryen.Return.setValue(e, x));
			return;
		case binaryen.MemoryGrowId:
			visit(binaryen.MemoryGrow.getDelta(e), (x) => binaryen.MemoryGrow.setDelta(e, x));
			return;
		default:
			if (leaves.has(id)) return;
			unknown.add(refused[id] ?? `expression kind ${id}`);
	}
}

type Class = 'stack' | 'static' | 'hoisted' | 'checked' | 'group';

// the bound trap goes through the slow import with a pointer and offset that wrap, so the message
// reads "address wrap ... (7770001 bytes)" on a host that has only the two original imports
export const EPOCH_BOUND_BYTES = 7770001;
const EPOCH_BOUND = 8;

interface Member {
	e: number;
	D: number;
	bytes: number;
	store: boolean;
	seq: number;
}

interface LoopRange {
	start: number;
	end: number;
}

interface Inst {
	base: number;
	members: Member[];
	minD: number;
	maxEnd: number;
	seq: number;
	t: number;
	pre: Inst[];
	preLoops: LoopRange[];
}

interface Pos {
	seq: number;
	avail: Inst[];
	loops: LoopRange[];
}

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
		sites: { stack: 0, static: 0, hoisted: 0, checked: 0, group: 0 },
		groups: 0,
		groupMembers: 0,
		groupSingletonsDropped: 0,
		groupReasons: {},
		epochSites: 0,
		prologueChecks: 0,
		hoistedLoops: 0,
		hoistedKeys: 0,
		cacheSites: 0,
		arenaSites: 0,
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
	const epochMode = !!options.epoch;
	if (epochMode && options.cache) throw new TranslateRefusal(['epoch groups with a cache']);
	const epochAddr = options.epochAddr ?? tableBase + 4 * 65536;
	const maxSpan = options.maxSpan ?? 4096;
	if (options.count)
		for (const cls of [
			'stack',
			'static',
			'hoisted',
			'checked',
			'miss',
			...(epochMode ? ['group', 'gchk', 'garena', 'gtable', 'epoch'] : [])
		]) {
			counters[cls] = `__folio_n_${cls}`;
			mod.addGlobal(counters[cls]!, i32, true, mod.i32.const(0));
			mod.addGlobalExport(counters[cls]!, counters[cls]!);
		}
	const bump = (name: string): number =>
		mod.global.set(name, mod.i32.add(mod.global.get(name, i32), mod.i32.const(1)));

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

	// arenas a group check may test: wide enough that size - span + 1 stays positive
	const groupArenas = arenas.filter((a) => a.size >= maxSpan);
	const groupMinLo = arenas.length ? Math.min(...arenas.map((a) => a.lo)) : 65536;

	if (epochMode) {
		// (b, m, span) -> delta of the page holding [b + m, b + m + span), or 0 inside an arena;
		// the table path of a group check and every re-check go through it
		const get = (k: number) => mod.local.get(k, i32);
		let inside: number | undefined;
		for (const { lo, size } of groupArenas) {
			const hit = mod.i32.lt_u(
				mod.i32.sub(get(3), mod.i32.const(lo | 0)),
				mod.i32.sub(mod.i32.const((size + 1) | 0), get(2))
			);
			inside = inside === undefined ? hit : mod.i32.or(inside, hit);
		}
		const wrapped = mod.select(
			mod.i32.ge_s(get(1), mod.i32.const(0)),
			mod.i32.lt_u(get(3), get(0)),
			mod.i32.gt_u(get(3), get(0))
		);
		const body = mod.block(
			null,
			[
				mod.local.set(3, mod.i32.add(get(0), get(1))),
				...(inside ? [mod.if(inside, mod.return(mod.i32.const(0)))] : []),
				mod.local.set(
					4,
					tableLoad(() => get(3))
				),
				mod.if(
					mod.i32.or(
						mod.i32.or(mod.i32.eq(get(4), mod.i32.const(MISS_ENTRY)), wrapped),
						mod.i32.gt_u(
							mod.i32.and(get(3), mod.i32.const(0xffff)),
							mod.i32.sub(mod.i32.const(LAST_BYTE_OF_PAGE), get(2))
						)
					),
					mod.local.set(4, mod.call(imports.slow, [get(0), get(1), get(2)], i32))
				),
				get(4)
			],
			i32
		);
		mod.addFunction('folio_gt', binaryen.createType([i32, i32, i32]), i32, [i32, i32], body);
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
		if (fname === 'folio_xl' || fname === 'folio_gt') continue;
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

		// epoch groups: state shared between the analysis pass and the rewrite
		const memberOf = new Map<number, Inst>();
		const posOf = new Map<number, Pos>();
		const keptSet = new Set<Inst>();
		let needEs = false;
		let curPos: number | undefined;
		let labelCount = 0;
		const epochNow = () => mod.i32.load(epochAddr, 4, mod.i32.const(0));
		const liveOf = (p: Pos | undefined): Inst[] =>
			p
				? p.avail.filter(
						(g) =>
							keptSet.has(g) &&
							(g.members.some((m) => m.seq > p.seq) ||
								p.loops.some(
									(l) =>
										g.seq <= l.start &&
										g.members.some((m) => m.seq > l.start && m.seq <= l.end)
								))
					)
				: [];
		// re-run the checks of the live groups, and `own` (the translation the caller is about to use),
		// until the epoch holds still; a distinct trap past the bound
		const recheck = (live: Inst[], own: (() => number)[] = []): number => {
			needEs = true;
			stats.epochSites++;
			const es = named('es', i32);
			const n = named('en', i32);
			const again = `folio_ep${labelCount++}`;
			const body = mod.block(null, [
				mod.local.set(n, mod.i32.const(0)),
				mod.loop(
					again,
					mod.block(null, [
						mod.local.set(es, epochNow()),
						...live.map((g) =>
							mod.local.set(
								g.t,
								mod.i32.add(
									get(g.base),
									mod.call(
										'folio_gt',
										[get(g.base), mod.i32.const(g.minD), mod.i32.const(g.maxEnd - g.minD)],
										i32
									)
								)
							)
						),
						...own.map((f) => f()),
						...(options.count ? [bump(counters.epoch!)] : []),
						mod.if(
							mod.i32.ne(epochNow(), get(es)),
							mod.block(null, [
								mod.local.set(n, mod.i32.add(get(n), mod.i32.const(1))),
								mod.if(
									mod.i32.gt_u(get(n), mod.i32.const(EPOCH_BOUND)),
									mod.block(null, [
										mod.drop(
											mod.call(
												imports.slow,
												[
													mod.i32.const(-1),
													mod.i32.const(1),
													mod.i32.const(EPOCH_BOUND_BYTES)
												],
												i32
											)
										),
										mod.unreachable()
									])
								),
								mod.br(again)
							])
						)
					])
				)
			]);
			return mod.if(mod.i32.ne(epochNow(), get(es)), body);
		};

		// the lookup of the address held in local P, offset o, into local `dest`
		const lookup = (
			o: number,
			bytes: number,
			straddle: boolean,
			dest: number,
			pLocal: number,
			// lookups taken earlier that this one's fault can evict (the earlier keys of a hoisted loop)
			earlier: (() => number)[] = []
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
			const after =
				epochMode && curPos !== undefined ? liveOf(posOf.get(curPos)) : ([] as Inst[]);
			const fault = () =>
				mod.local.set(
					dest,
					slowCall(() => get(pLocal), o, bytes)
				);
			// the re-check can evict the frame this access just got, so it re-runs the lookup too
			out.push(
				mod.if(
					slow,
					after.length || earlier.length
						? mod.block(null, [fault(), recheck(after, [...earlier, fault])])
						: fault()
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

		const counted = (cls: Class, ptr: number): number => {
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

		// pass 1 of epoch groups: walk in evaluation order with the set of groups whose check has run
		// on every path to the current point. A group is the first access to a base local after the
		// last set of that local; later accesses it dominates join it. Anything else keeps the
		// per-access code.
		const writesIn = (e: number, out: Set<number>) => {
			const id = binaryen.getExpressionId(e);
			if (id === binaryen.LocalSetId) out.add(binaryen.LocalSet.getIndex(e));
			children(e, id, (c) => writesIn(c, out), unknown);
		};
		const analyze = (root: number): Inst[] => {
			type State = Map<number, Inst> | null;
			let seq = 0;
			let state: State = new Map();
			const pending = new Map<string, Map<number, Inst>>();
			const loopStack: LoopRange[] = [];
			const insts: Inst[] = [];
			const created = new Set<number>();
			const copy = (s: State): State => (s ? new Map(s) : null);
			const join = (a: State, b: State): State => {
				if (!a) return copy(b);
				if (!b) return copy(a);
				const out = new Map<number, Inst>();
				for (const [k, v] of a) if (b.get(k) === v) out.set(k, v);
				return out;
			};
			const toLabel = (name: string) => {
				if (!state || !name) return;
				const prior = pending.get(name);
				pending.set(name, prior ? (join(prior, state) as Map<number, Inst>) : new Map(state));
			};
			const snapshot = (): Pos => ({
				seq,
				avail: state ? [...state.values()] : [],
				loops: [...loopStack]
			});
			const event = (e: number, isStore: boolean) => {
				const s = ++seq;
				const ptr = isStore ? binaryen.Store.getPtr(e) : binaryen.Load.getPtr(e);
				const atomic = isStore ? binaryen.Store.isAtomic(e) : binaryen.Load.isAtomic(e);
				const valueType = isStore
					? binaryen.getExpressionType(binaryen.Store.getValue(e))
					: binaryen.getExpressionType(e);
				if (
					binaryen.getExpressionType(ptr) === binaryen.unreachable ||
					atomic ||
					valueType === binaryen.v128 ||
					(isStore && valueType === binaryen.unreachable)
				)
					return;
				const o = isStore ? binaryen.Store.getOffset(e) : binaryen.Load.getOffset(e);
				const bytes = isStore ? binaryen.Store.getBytes(e) : binaryen.Load.getBytes(e);
				if (classify(ptr, o, bytes) !== 'checked') return;
				posOf.set(e, snapshot());
				const why = (r: string) => {
					stats.groupReasons[r] = (stats.groupReasons[r] ?? 0) + 1;
				};
				const k = keyOf(ptr, o);
				if (!k) return why('notBase');
				if (!state) return why('unreachable');
				const { base, add } = k;
				if (o >= groupMinLo || add < -65536 || add > 65535 || (add < 0 && o > 0))
					return why('offsetRange');
				const D = add + o;
				if (D >= groupMinLo || D < -65536) return why('offsetRange');
				if (isStore) {
					const value = binaryen.Store.getValue(e);
					const vid = binaryen.getExpressionId(value);
					const simple =
						vid === binaryen.ConstId ||
						vid === binaryen.LocalGetId ||
						vid === binaryen.GlobalGetId;
					if (!simple) {
						const w = new Set<number>();
						writesIn(value, w);
						// the pointer was read before the value ran, so a value that moves the base cannot share
						if (w.has(base)) return why('valueWritesBase');
					}
				}
				const member: Member = { e, D, bytes, store: isStore, seq: s };
				const inst = state.get(base);
				if (inst) {
					const minD = Math.min(inst.minD, D);
					const maxEnd = Math.max(inst.maxEnd, D + bytes);
					if (maxEnd - minD > maxSpan) return why('span');
					inst.minD = minD;
					inst.maxEnd = maxEnd;
					inst.members.push(member);
					memberOf.set(e, inst);
				} else if (!created.has(base)) {
					const fresh: Inst = {
						base,
						members: [member],
						minD: D,
						maxEnd: D + bytes,
						seq: s,
						t: -1,
						pre: [...state.values()],
						preLoops: [...loopStack]
					};
					created.add(base);
					state.set(base, fresh);
					insts.push(fresh);
					memberOf.set(e, fresh);
				} else why('notDominated');
			};
			const an = (e: number): void => {
				const id = binaryen.getExpressionId(e);
				switch (id) {
					case binaryen.BlockId: {
						const name = binaryen.Block.getName(e);
						for (let k = 0, n = binaryen.Block.getNumChildren(e); k < n; k++)
							an(binaryen.Block.getChildAt(e, k));
						if (name && pending.has(name)) {
							state = join(state, pending.get(name)!);
							pending.delete(name);
						}
						return;
					}
					case binaryen.IfId: {
						an(binaryen.If.getCondition(e));
						const entry = copy(state);
						an(binaryen.If.getIfTrue(e));
						const afterThen = state;
						state = entry;
						const ifFalse = binaryen.If.getIfFalse(e);
						if (ifFalse) an(ifFalse);
						state = join(afterThen, state);
						return;
					}
					case binaryen.LoopId: {
						const range: LoopRange = { start: seq, end: seq };
						if (state) {
							const w = new Set<number>();
							writesIn(binaryen.Loop.getBody(e), w);
							for (const b of w) state.delete(b);
						}
						let planned = false;
						if (options.hoist && !plan) {
							const found = analyzeLoop(e);
							if (found) {
								plan = found;
								planned = true;
								posOf.set(e, snapshot());
							}
						}
						loopStack.push(range);
						an(binaryen.Loop.getBody(e));
						loopStack.pop();
						range.end = seq;
						if (planned) plan = undefined;
						return;
					}
					case binaryen.BreakId: {
						const value = binaryen.Break.getValue(e);
						const cond = binaryen.Break.getCondition(e);
						if (value) an(value);
						if (cond) an(cond);
						toLabel(binaryen.Break.getName(e));
						if (!cond) state = null;
						return;
					}
					case binaryen.SwitchId: {
						const value = binaryen.Switch.getValue(e);
						if (value) an(value);
						an(binaryen.Switch.getCondition(e));
						for (let k = 0, n = binaryen.Switch.getNumNames(e); k < n; k++)
							toLabel(binaryen.Switch.getNameAt(e, k));
						toLabel(binaryen.Switch.getDefaultName(e));
						state = null;
						return;
					}
					case binaryen.ReturnId:
						if (binaryen.Return.getValue(e)) an(binaryen.Return.getValue(e));
						state = null;
						return;
					case binaryen.UnreachableId:
						state = null;
						return;
					case binaryen.CallId:
						for (let k = 0, n = binaryen.Call.getNumOperands(e); k < n; k++)
							an(binaryen.Call.getOperandAt(e, k));
						seq++;
						posOf.set(e, snapshot());
						return;
					case binaryen.CallIndirectId:
						for (let k = 0, n = binaryen.CallIndirect.getNumOperands(e); k < n; k++)
							an(binaryen.CallIndirect.getOperandAt(e, k));
						an(binaryen.CallIndirect.getTarget(e));
						seq++;
						posOf.set(e, snapshot());
						return;
					case binaryen.LocalSetId: {
						an(binaryen.LocalSet.getValue(e));
						const index = binaryen.LocalSet.getIndex(e);
						state?.delete(index);
						created.delete(index);
						return;
					}
					case binaryen.GlobalSetId:
						an(binaryen.GlobalSet.getValue(e));
						return;
					case binaryen.LoadId:
						an(binaryen.Load.getPtr(e));
						event(e, false);
						return;
					case binaryen.StoreId:
						an(binaryen.Store.getPtr(e));
						an(binaryen.Store.getValue(e));
						event(e, true);
						return;
					case binaryen.UnaryId:
						an(binaryen.Unary.getValue(e));
						return;
					case binaryen.BinaryId:
						an(binaryen.Binary.getLeft(e));
						an(binaryen.Binary.getRight(e));
						return;
					case binaryen.SelectId:
						an(binaryen.Select.getIfTrue(e));
						an(binaryen.Select.getIfFalse(e));
						an(binaryen.Select.getCondition(e));
						return;
					case binaryen.DropId:
						an(binaryen.Drop.getValue(e));
						return;
					case binaryen.MemoryGrowId:
						an(binaryen.MemoryGrow.getDelta(e));
						return;
					default:
						if (leaves.has(id)) return;
						unknown.add(refused[id] ?? `expression kind ${id}`);
				}
			};
			an(root);
			return insts;
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

		// the check of a group: the translated base, from the arena compare or, outside every arena,
		// from the shared table lookup
		const checkExpr = (g: Inst): number => {
			const b = () => get(g.base);
			const m = g.minD;
			const span = g.maxEnd - g.minD;
			let outside: number | undefined;
			for (const { lo, size } of groupArenas) {
				const out = mod.i32.ge_u(
					mod.i32.add(b(), mod.i32.const((m - lo) | 0)),
					mod.i32.const((size - span + 1) | 0)
				);
				outside = outside === undefined ? out : mod.i32.and(outside, out);
			}
			const pre = liveOf({ seq: g.seq, avail: g.pre, loops: g.preLoops });
			const table = mod.block(
				null,
				[
					...(options.count ? [bump(counters.gtable!)] : []),
					mod.local.set(
						g.t,
						mod.i32.add(
							b(),
							mod.call(
								'folio_gt',
								[b(), mod.i32.const(m), mod.i32.const(span)],
								i32
							)
						)
					),
					...(pre.length ? [recheck([...pre, g])] : []),
					get(g.t)
				],
				i32
			);
			const checked =
				outside === undefined
					? table
					: mod.if(
							outside,
							table,
							options.count ? mod.block(null, [bump(counters.garena!), b()], i32) : b()
						);
			return options.count
				? mod.block(null, [bump(counters.gchk!), checked], i32)
				: checked;
		};
		// the pointer of a group member: the translated base, plus the constant it already had
		const memberPtr = (g: Inst, e: number, ptr: number): number => {
			const plain = binaryen.getExpressionId(ptr) === binaryen.LocalGetId;
			const first = g.members[0]!.e === e;
			const base = first ? mod.local.tee(g.t, checkExpr(g), i32) : get(g.t);
			return plain
				? base
				: mod.i32.add(base, mod.i32.const(constOf(binaryen.Binary.getRight(ptr))!));
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
				const member = memberOf.get(e);
				if (member) {
					stats.sites.group++;
					binaryen.Load.setPtr(e, counted('group', memberPtr(member, e, ptr)));
					return level;
				}
				curPos = e;
				const cls = classify(ptr, o, bytes);
				stats.sites[cls]++;
				if (cls === 'checked')
					binaryen.Load.setPtr(
						e,
						counted(cls, translated(ptr, o, bytes, binaryen.Load.getAlign(e)))
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
				const member = memberOf.get(e);
				if (member) {
					stats.sites.group++;
					const grouped = counted('group', memberPtr(member, e, ptr));
					const mid = binaryen.getExpressionId(value);
					if (
						mid === binaryen.ConstId ||
						mid === binaryen.LocalGetId ||
						mid === binaryen.GlobalGetId
					) {
						binaryen.Store.setPtr(e, grouped);
						return level;
					}
					// the base is read after the value, so a re-check inside the value is seen
					const depth = valueLevel + 1;
					const tv = named(`sv${depth}`, valueType);
					binaryen.Store.setPtr(e, grouped);
					binaryen.Store.setValue(e, get(tv, valueType));
					set(mod.block(null, [mod.local.set(tv, value), e]));
					return depth;
				}
				curPos = e;
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
				const vid = binaryen.getExpressionId(value);
				const simple =
					vid === binaryen.ConstId ||
					vid === binaryen.LocalGetId ||
					vid === binaryen.GlobalGetId;
				const align = binaryen.Store.getAlign(e);
				if (simple) {
					binaryen.Store.setPtr(e, counted(cls, translated(ptr, o, bytes, align)));
					return level;
				}
				// translate after the value, so a miss inside the value cannot invalidate the frame
				const depth = valueLevel + 1;
				const tp = named(`sp${depth}`, i32);
				const tv = named(`sv${depth}`, valueType);
				binaryen.Store.setPtr(e, counted(cls, translated(get(tp), o, bytes, align)));
				binaryen.Store.setValue(e, get(tv, valueType));
				set(mod.block(null, [mod.local.set(tp, ptr), mod.local.set(tv, value), e]));
				return depth;
			}
			if (id === binaryen.LoopId && options.hoist && !plan) {
				const found = analyzeLoop(e);
				if (found) {
					plan = found;
					curPos = e;
					const pre: number[] = [];
					const taken: (() => number)[] = [];
					for (const key of found.keys.values()) {
						key.local = binaryen._BinaryenFunctionAddVar(fn, i32);
						const p = P();
						const base = get(key.base);
						pre.push(
							mod.local.set(
								p,
								key.add ? mod.i32.add(base, mod.i32.const(key.add)) : base
							),
							...lookup(key.offset, key.bytes, key.straddle, key.local, p, [...taken])
						);
						if (epochMode)
							taken.push(() =>
								mod.local.set(
									key.local,
									slowCall(
										() =>
											key.add
												? mod.i32.add(get(key.base), mod.i32.const(key.add))
												: get(key.base),
										key.offset,
										key.bytes
									)
								)
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
			if (epochMode && (id === binaryen.CallId || id === binaryen.CallIndirectId)) {
				const live = liveOf(posOf.get(e));
				const type = binaryen.getExpressionType(e);
				if (live.length && type !== binaryen.unreachable) {
					const check = recheck(live);
					if (type === binaryen.none) set(mod.block(null, [e, check]));
					else {
						if (binaryen.expandType(type).length !== 1)
							throw new TranslateRefusal(['multivalue call with live groups']);
						const r = named('cr', type);
						set(
							mod.block(
								null,
								[mod.local.set(r, e), check, mod.local.get(r, type)],
								type
							)
						);
					}
				}
			}
			return level;
		};

		if (epochMode) {
			for (const g of analyze(body)) {
				if (g.members.length < 2) {
					for (const m of g.members) memberOf.delete(m.e);
					stats.groupSingletonsDropped++;
					continue;
				}
				keptSet.add(g);
				g.t = binaryen._BinaryenFunctionAddVar(fn, i32);
				stats.groups++;
				stats.groupMembers += g.members.length;
			}
		}
		rewrite(body, (x) => binaryen.Function.setBody(fn, x));
		if (needEs) {
			const rewritten = binaryen.Function.getBody(fn);
			binaryen.Function.setBody(
				fn,
				mod.block(
					null,
					[mod.local.set(named('es', i32), epochNow()), rewritten],
					binaryen.getExpressionType(rewritten)
				)
			);
		}
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
