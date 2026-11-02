import binaryen from 'binaryen';
import { stackRoute } from './extract.ts';
import { importedMemory, shareMemory } from './iteration-owner.ts';

type Info = ReturnType<typeof binaryen.getExpressionInfo> & Record<string, any>;
const info = (expression: number): Info => {
	const id = binaryen.getExpressionId(expression);
	if (id === binaryen.UnreachableId || id === binaryen.NopId) {
		return { id, type: binaryen.getExpressionType(expression) } as Info;
	}
	return binaryen.getExpressionInfo(expression) as Info;
};

// #region inline tracking lowering
const capi = binaryen as any;

/** Names of the exported mutable i32 globals the inline lowering adds, plus the stack export. */
export const inlineGlobals = {
	readBitmap: '__folio_rb',
	writeBitmap: '__folio_wb',
	logPointer: '__folio_lp',
	logLimit: '__folio_ll',
	stampAddress: '__folio_sa',
	stackPointer: '__folio_sp',
	frameLow: '__folio_fl',
	frameSize: '__folio_fn',
	frameShadow: '__folio_fs',
	exemptLow: '__folio_xl',
	exemptEnd: '__folio_xe',
	slotLow: '__folio_sl',
	slotEnd: '__folio_se',
	arenaLow: '__folio_al',
	arenaEnd: '__folio_ae',
	violation: '__folio_xv',
	windowLow: '__folio_wl',
	windowEnd: '__folio_we',
	windowDelta: '__folio_wd',
	readWindow0Low: '__folio_r0l',
	readWindow0Span: '__folio_r0m',
	readWindow1Low: '__folio_r1l',
	readWindow1Span: '__folio_r1m',
	readSummary: '__folio_rs',
	readHits: '__folio_ch',
	readMisses: '__folio_cm',
	readExempt: '__folio_ce'
} as const;

/** Bytes of one undo entry: the granule address, the stamp, then the prior bytes of the granule. */
export const inlineEntryBytes = (writeGranule = 32): number => 8 + writeGranule;

/** Options for `lowerInline`. */
export interface InlineOptions {
	/** Read granule in bytes, a power of two from 16 to 4096. Default 64. */
	readGranule?: number;
	/** Write and undo granule in bytes, a power of two from 16 to 256. Default 32. */
	writeGranule?: number;
	/** Refuse a memory that is not shared. Pass false to lower a module for one thread. Default true. */
	requireShared?: boolean;
	/** The mutable i32 global exported as `__folio_sp`. Default: the one `stackRoute` names, if any. */
	stack?: string;
	/** Track exposed reads of one frame region (see `lowerInline`). Default off. */
	frame?: boolean;
	/** Leave one private stack window untracked and trap on another slot (see `lowerInline`). Default off. */
	slot?: boolean;
	/**
	 * Rebase accesses to one address window onto a slot-private copy (see `lowerInline`). Turns
	 * `frame` on, and `slot` when there is a stack global. Default off.
	 */
	window?: boolean;
	/**
	 * Trap an access that overlaps the window `[__folio_al, __folio_ae)`, with no stack global
	 * needed and no exempt or own window. For a lane whose arena sits above the program memory.
	 * Default off.
	 */
	guard?: boolean;
	/**
	 * Count a fuel unit at every function entry and loop start, as the host-call lowering does:
	 * `__folio_set_fuel(n)` sets the budget and `folio.exhausted` is called when it reaches 0.
	 * Default off.
	 */
	fuel?: boolean;
	/**
	 * Poll the i32 at `__folio_sa + 4` at every loop start and trap with `unreachable` when it is
	 * not zero, so the host can stop an iteration that does not return. Function entries are not
	 * polled: a call cycle runs out of stack and traps by itself. Default off.
	 */
	stop?: boolean;
	/**
	 * Read windows, 0 to 2: a load of at most 8 bytes that lies inside one sets no read mark and
	 * runs none of the slot or frame checks (see `lowerInline`). Default 0.
	 */
	readWindows?: number;
	/**
	 * Bytes of the read summary, a power of two from 1 to 32768, or 0 for none (see `lowerInline`).
	 * Default 0.
	 */
	readSummary?: number;
	/**
	 * With read windows, count the loads of at most 8 bytes by where they land: `__folio_ch` inside
	 * a window, `__folio_cm` outside every window and tracked, `__folio_ce` in the exempt window.
	 * The owner resets them. Default off.
	 */
	readCount?: boolean;
	/**
	 * With read windows, test the exempt window before the windows instead of after them. An exempt
	 * load then costs what it does with no windows and a hit costs 10 instructions more. Default off.
	 */
	exemptFirst?: boolean;
}

const inlineHelpers = [
	'__folio_x_trap',
	'__folio_x_r_range',
	'__folio_x_w_range',
	'__folio_r_mark',
	'__folio_w_mark',
	'__folio_w_set',
	'__folio_undo',
	'__folio_r_range',
	'__folio_w_range',
	'__folio_f_r',
	'__folio_f_w',
	'__folio_f_rr',
	'__folio_f_rw',
	'__folio_w_rebase'
];
const inlineLeaves = new Set([
	binaryen.ConstId,
	binaryen.LocalGetId,
	binaryen.GlobalGetId,
	binaryen.NopId,
	binaryen.UnreachableId,
	binaryen.MemorySizeId,
	binaryen.DataDropId,
	binaryen.AtomicFenceId
]);
const simdLoadBytes = new Map<number, number>([
	[binaryen.Operations.Load8SplatVec128, 1],
	[binaryen.Operations.Load16SplatVec128, 2],
	[binaryen.Operations.Load32SplatVec128, 4],
	[binaryen.Operations.Load64SplatVec128, 8],
	[binaryen.Operations.Load8x8SVec128, 8],
	[binaryen.Operations.Load8x8UVec128, 8],
	[binaryen.Operations.Load16x4SVec128, 8],
	[binaryen.Operations.Load16x4UVec128, 8],
	[binaryen.Operations.Load32x2SVec128, 8],
	[binaryen.Operations.Load32x2UVec128, 8],
	[binaryen.Operations.Load32ZeroVec128, 4],
	[binaryen.Operations.Load64ZeroVec128, 8]
]);
const simdLaneBytes = new Map<number, number>([
	[binaryen.Operations.Load8LaneVec128, 1],
	[binaryen.Operations.Load16LaneVec128, 2],
	[binaryen.Operations.Load32LaneVec128, 4],
	[binaryen.Operations.Load64LaneVec128, 8],
	[binaryen.Operations.Store8LaneVec128, 1],
	[binaryen.Operations.Store16LaneVec128, 2],
	[binaryen.Operations.Store32LaneVec128, 4],
	[binaryen.Operations.Store64LaneVec128, 8]
]);

// operand expressions of every node the lowering may meet; anything else is refused by name
function inlineChildren(v: Info): number[] {
	switch (v.id) {
		case binaryen.BlockId:
			return v.children;
		case binaryen.IfId:
			return [v.condition, v.ifTrue, v.ifFalse].filter(Boolean);
		case binaryen.LoopId:
			return [v.body];
		case binaryen.BreakId:
		case binaryen.SwitchId:
			return [v.value, v.condition].filter(Boolean);
		case binaryen.CallId:
			return v.operands;
		case binaryen.CallIndirectId:
			return [...v.operands, v.target];
		case binaryen.LocalSetId:
		case binaryen.GlobalSetId:
		case binaryen.UnaryId:
		case binaryen.DropId:
			return [v.value];
		case binaryen.ReturnId:
			return v.value ? [v.value] : [];
		case binaryen.LoadId:
		case binaryen.SIMDLoadId:
			return [v.ptr];
		case binaryen.StoreId:
		case binaryen.AtomicRMWId:
			return [v.ptr, v.value];
		case binaryen.BinaryId:
		case binaryen.SIMDShuffleId:
			return [v.left, v.right];
		case binaryen.SelectId:
			return [v.ifTrue, v.ifFalse, v.condition];
		case binaryen.MemoryGrowId:
			return [v.delta];
		case binaryen.MemoryCopyId:
			return [v.dest, v.source, v.size];
		case binaryen.MemoryFillId:
			return [v.dest, v.value, v.size];
		case binaryen.MemoryInitId:
			return [v.dest, v.offset, v.size];
		case binaryen.AtomicCmpxchgId:
			return [v.ptr, v.expected, v.replacement];
		case binaryen.AtomicWaitId:
			return [v.ptr, v.expected, v.timeout];
		case binaryen.AtomicNotifyId:
			return [v.ptr, v.notifyCount];
		case binaryen.SIMDExtractId:
			return [v.vec];
		case binaryen.SIMDReplaceId:
			return [v.vec, v.value];
		case binaryen.SIMDTernaryId:
			return [v.a, v.b, v.c];
		case binaryen.SIMDShiftId:
			return [v.vec, v.shift];
		case binaryen.SIMDLoadStoreLaneId:
			return [v.ptr, v.vec];
		default:
			if (inlineLeaves.has(v.id)) return [];
			throw new Error(`unsupported expression ${v.id}`);
	}
}

function granuleShift(value: number | undefined, fallback: number, low: number, high: number) {
	const size = value ?? fallback;
	if (!Number.isInteger(size) || size < low || size > high || size & (size - 1))
		throw new RangeError(`granule must be a power of two from ${low} to ${high}`);
	return Math.log2(size);
}

function memoryCount(bytes: Uint8Array, native: WebAssembly.Module): number {
	let cursor = 8,
		defined = 0;
	const unsigned = (): number => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	while (cursor < bytes.length) {
		const section = bytes[cursor++]!;
		const end = unsigned() + cursor;
		if (section === 5) defined = unsigned();
		cursor = end;
	}
	return defined + WebAssembly.Module.imports(native).filter((i) => i.kind === 'memory').length;
}

/**
 * A second lowering, next to the host-call one in `prepare`: it marks memory accesses inline, with
 * no host call and no added import, so a region can be validated after it ran. Nothing in
 * `prepare` calls it yet and its output is not a `PreparedProgram` field.
 *
 * State lives in mutable i32 globals the owner exports and sets before each region; all start at
 * 0, which traps on the first access. `__folio_rb` and `__folio_wb` are the bases of the read and
 * write bitmaps, `__folio_lp` and `__folio_ll` the undo log pointer and limit, `__folio_sa` the
 * address of a shared i32 stamp counter (4-byte aligned). The stack pointer global is exported as
 * `__folio_sp` when the module has one. A bitmap has one bit per granule: granule `g`, with
 * `g = address >> log2(granule)`, is bit `g & 7` of byte `base + (g >> 3)`. The bitmaps are
 * private to a region and the owner clears them between regions.
 *
 * Every load, store, atomic access and SIMD load marks its read granule, and an access that
 * crosses a boundary marks both. A store, a SIMD lane store and the destination of `memory.copy`,
 * `memory.fill` and `memory.init` mark write granules; atomic accesses mark both sets; the source
 * of `memory.copy` marks read granules. The first write to a write granule appends an undo entry
 * at `__folio_lp`: the granule address (u32), a stamp from an atomic add on `__folio_sa` taken
 * after the prior bytes were copied and before the write, then the prior bytes of the granule.
 * `__folio_lp` then advances by `inlineEntryBytes(writeGranule)`; an entry that would pass
 * `__folio_ll` traps with `unreachable`. The start function is not lowered.
 *
 * With `frame: true` the module also tracks one frame region, for a stack frame whose bytes an
 * iteration may read after an earlier iteration wrote them. The owner sets `__folio_fl` (low
 * address), `__folio_fn` (size in bytes) and `__folio_fs` (shadow base) before a region; with
 * `__folio_fn` at 0 nothing is tracked. An access that overlaps the region is checked against a
 * shadow of one written bit per frame byte, `4 * ceil(size / 32)` bytes with the bits of frame
 * granule `g` (32 bytes) in the i32 at `__folio_fs + 4 * g`, then 4 pad bytes, then the exposed
 * bits laid out the same way, then 4 more pad bytes. A store sets written bits after its value is
 * computed; a load sets the exposed bit of each byte it reads whose written bit is clear, so a
 * region reports exactly the frame bytes it read before it wrote them.
 * `memory.copy`, `memory.fill` and `memory.init` set or check the exact byte range, an atomic
 * read-modify-write checks then sets, and any other atomic access or SIMD load checks. The owner
 * zeroes the shadow before each region. Accesses outside the region pay one compare. Stack below
 * the region is not tracked.
 *
 * With `slot: true` and a stack global, the owner also sets three address windows before a region:
 * the exempt window `[__folio_xl, __folio_xe)`, the whole private slot `[__folio_sl, __folio_se)`
 * and the arena of all slots `[__folio_al, __folio_ae)`. An access inside the exempt window sets no
 * mark and logs no undo entry. An access that overlaps the arena but does not lie inside the own
 * slot stores its address in `__folio_xv` and traps with `unreachable`, because another iteration
 * owns those bytes. Every other access is tracked as before, so the exempt window must not contain
 * the tracked frame; an access that crosses the window edge is tracked. `memory.copy`,
 * `memory.fill` and `memory.init` apply the same tests to the whole range, and a range counts as
 * inside only when every byte is. The exempt bytes are not restored by a rollback, so the owner
 * must treat the window as dead after the region.
 *
 * With `readWindows: n` the owner also sets, per window `i` below `n`, `__folio_r<i>l` (first byte)
 * and `__folio_r<i>m` (window size minus 7, or 0 for no window) before a region, and marks every
 * read granule that the window touches in the read bitmap itself. A plain, non-atomic load or SIMD
 * load of at most 8 bytes whose address `a` satisfies `a - low < size - 7` lies wholly inside the
 * window, so its read mark is already set: it sets no mark and skips the slot, arena and frame
 * checks. Every other access, a store, an atomic, a wider load, a load that crosses a window edge
 * and every bulk operation, is tracked as before. The window must lie outside the arena of all
 * slots and the owner frame region, which is what those checks would have found; a false conflict
 * is possible only for a granule of the window that another iteration writes and this one does
 * not read. The exempt window is tested first, so an exempt load executes what it does without
 * windows; the guards of the windows run only for a load outside it. With `readCount` the lowering
 * also counts those loads by where they land (`__folio_ch`, `__folio_cm`, `__folio_ce`).
 *
 * With `readSummary: n` every read mark also sets one byte of the summary at `__folio_rs`, before
 * the bit it summarizes. The byte is `(a >> (log2(readGranule) + 11)) & (n - 1)` for address `a`,
 * one byte per 64 words of the read bitmap. A bitmap word is never non-zero while its summary byte
 * is zero, so a scan may skip the blocks whose byte is zero. The owner sets the bytes of any
 * granule it marks itself, a read window for one, and clears a byte only when it clears the words
 * of its block. An address past the memory wraps to a byte that covers other words, which only
 * adds blocks to scan. The owner must also set `n` large enough that every address of the memory
 * has its own byte, or the scan visits blocks it need not.
 *
 * With `window: true` (which implies `frame`, and `slot` when there is a stack global) the owner also sets `__folio_wl` and
 * `__folio_we`, a window of the address space, and `__folio_wd`, the distance from it to a private
 * copy that lies inside the tracked frame region. A load, store, atomic or SIMD access that lies in
 * the window runs on the copy (`address + __folio_wd`), a bulk operation does the same when its
 * whole range is inside, and an access or range that crosses the window edge traps with
 * `unreachable`. Accesses in the tracked frame region, the copy included, set no bitmap mark and
 * log no undo entry: their only record is the frame shadow, whose exposed bits the owner
 * validates, and the copy is discarded or committed byte by byte from the written bits. With the
 * window empty (`__folio_we` at 0) nothing is rebased.
 *
 * Throws for a module without exactly one memory, a 64-bit memory, an unshared memory when
 * `requireShared` is set, a start function that calls, a reserved name or an expression it does
 * not know. An imported host function that touches memory is not seen.
 */
export function lowerInline(bytes: Uint8Array, options: InlineOptions = {}): Uint8Array {
	const rg = granuleShift(options.readGranule, 64, 16, 4096);
	const wg = granuleShift(options.writeGranule, 32, 16, 256);
	const entry = inlineEntryBytes(1 << wg);
	const readWindows = options.readWindows ?? 0;
	if (!Number.isInteger(readWindows) || readWindows < 0 || readWindows > 2)
		throw new RangeError('read windows must be 0, 1 or 2');
	const summary = options.readSummary ?? 0;
	if (!Number.isInteger(summary) || summary < 0 || summary > 32768 || summary & (summary - 1))
		throw new RangeError('read summary must be 0 or a power of two up to 32768');
	const original = Uint8Array.from(bytes);
	const native = new WebAssembly.Module(original);
	if (memoryCount(original, native) !== 1) throw new Error('exactly one memory required');
	const stack = options.stack ?? stackRoute(original).stack?.name;
	const m = binaryen.readBinary(original);
	try {
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		m.setFeatures(binaryen.Features.All & ~compactImports);
		const memory = m.getMemoryInfo();
		if (memory.is64) throw new Error('memory64 is not supported');
		if ((options.requireShared ?? true) && !memory.shared)
			throw new Error('shared memory required; pass requireShared: false for one thread');
		const fuel = Boolean(options.fuel);
		const reserved = [
			...Object.values(inlineGlobals),
			...inlineHelpers,
			...(fuel ? ['__folio_fuel', '__folio_exhausted', '__folio_set_fuel'] : [])
		];
		if (reserved.some((name) => m.getGlobal(name) || m.getFunction(name) || m.getExport(name)))
			throw new Error('reserved function name');
		if (stack !== undefined) {
			const global = m.getGlobal(stack);
			const shape = global ? binaryen.getGlobalInfo(global) : undefined;
			if (!shape || !shape.mutable || shape.type !== binaryen.i32 || shape.module)
				throw new Error(`stack global ${stack} is not a defined mutable i32`);
		}
		const window = Boolean(options.window);
		const frame = Boolean(options.frame) || window;
		const slot =
			((Boolean(options.slot) || window) && stack !== undefined) || Boolean(options.guard);
		const { exemptLow: xl, exemptEnd: xe, slotLow: sl, slotEnd: se } = inlineGlobals;
		const { arenaLow: al, arenaEnd: ae, violation: xv } = inlineGlobals;
		const { windowLow: wl, windowEnd: we, windowDelta: wd } = inlineGlobals;
		const { readWindow0Low: r0l, readWindow0Span: r0m } = inlineGlobals;
		const { readWindow1Low: r1l, readWindow1Span: r1m } = inlineGlobals;
		const rs = inlineGlobals.readSummary;
		const { readHits: ch, readMisses: cm, readExempt: ce } = inlineGlobals;
		const counting = Boolean(options.readCount) && readWindows > 0;
		const rb = inlineGlobals.readBitmap,
			wb = inlineGlobals.writeBitmap,
			lp = inlineGlobals.logPointer,
			ll = inlineGlobals.logLimit,
			sa = inlineGlobals.stampAddress,
			fl = inlineGlobals.frameLow,
			fn = inlineGlobals.frameSize,
			fs = inlineGlobals.frameShadow;
		const i32 = binaryen.i32,
			none = binaryen.none;
		const c = (value: number) => m.i32.const(value | 0);
		const g = (name: string) => m.global.get(name, i32);
		const l = (index: number) => m.local.get(index, i32);
		const call = (name: string, ...args: number[]) => m.call(name, args, none);
		const bitOf = (address: () => number, shift: number) =>
			m.i32.shl(c(1), m.i32.and(m.i32.shr_u(address(), c(shift)), c(7)));
		const byteOf = (base: string, address: () => number, shift: number) =>
			m.i32.add(g(base), m.i32.shr_u(address(), c(shift + 3)));
		const setBit = (base: string, address: () => number, shift: number) =>
			m.i32.store8(
				0,
				1,
				byteOf(base, address, shift),
				m.i32.or(m.i32.load8_u(0, 1, byteOf(base, address, shift)), bitOf(address, shift))
			);
		// the summary byte goes first, so the bit is never set without it
		const markRead = (address: () => number) =>
			summary
				? m.block(
						null,
						[
							m.i32.store8(
								0,
								1,
								m.i32.add(
									g(rs),
									m.i32.and(m.i32.shr_u(address(), c(rg + 11)), c(summary - 1))
								),
								c(1)
							),
							setBit(rb, address, rg)
						],
						none
					)
				: setBit(rb, address, rg);
		const unmarked = (address: () => number) =>
			m.i32.eqz(m.i32.and(m.i32.load8_u(0, 1, byteOf(wb, address, wg)), bitOf(address, wg)));
		// does an access of `width` bytes at the address overlap the frame region
		const inFrame = (address: () => number, width: number) =>
			width === 1
				? m.i32.lt_u(m.i32.sub(address(), g(fl)), g(fn))
				: m.i32.lt_u(
						m.i32.add(m.i32.sub(address(), g(fl)), c(width - 1)),
						m.i32.add(g(fn), c(width - 1))
					);
		const frameCall = (name: string, address: () => number, width: number) =>
			m.if(inFrame(address, width), call(name, address(), c(width)));
		// does [address, address + width) lie inside the window named by two globals
		const within = (low: string, end: string, address: () => number, width: number) =>
			m.i32.and(
				m.i32.ge_u(address(), g(low)),
				m.i32.le_u(m.i32.add(address(), width), g(end))
			);
		// does [address, address + width) overlap the arena of all slots
		const overlapsArena = (address: () => number, width: number) =>
			m.i32.and(m.i32.lt_u(address(), g(ae)), m.i32.gt_u(m.i32.add(address(), width), g(al)));
		// does [address, address + width) lie inside the tracked frame region
		const inRegion = (address: () => number, width: number | (() => number)) =>
			m.i32.and(
				m.i32.ge_u(address(), g(fl)),
				m.i32.le_u(
					m.i32.add(address(), typeof width === 'number' ? c(width) : width()),
					m.i32.add(g(fl), g(fn))
				)
			);
		const hold = (local: number, value: number) =>
			m.block(null, [m.local.set(local, value), l(local)], i32);
		const tick = () =>
			m.block(
				null,
				[
					m.global.set('__folio_fuel', m.i32.sub(g('__folio_fuel'), c(1))),
					m.if(m.i32.le_s(g('__folio_fuel'), c(0)), m.call('__folio_exhausted', [], none))
				],
				none
			);
		const stop = Boolean(options.stop);
		const poll = () => m.if(m.i32.atomic.load(4, g(sa)), m.unreachable());
		const startRef = m.getStart();
		const start = startRef ? binaryen.getFunctionInfo(startRef).name : undefined;
		const callsOut = (expression: number): boolean => {
			const v = info(expression);
			return v.id === binaryen.CallId || inlineChildren(v).some(callsOut);
		};
		for (let index = 0, count = m.getNumFunctions(); index < count; index++) {
			const f = m.getFunctionByIndex(index);
			const { name, body } = binaryen.getFunctionInfo(f);
			if (!body) continue;
			if (name === start) {
				if (callsOut(body)) throw new Error('start function calls another function');
				continue;
			}
			const vars = (n: number): number[] =>
				Array.from({ length: n }, () => capi._BinaryenFunctionAddVar(f, i32));
			let pointer = -1,
				effective = -1;
			const temps = new Map<number, number>();
			// a frame store marks its written bits after its value is computed, from a saved address
			const afterValue = (value: number, saved: number, width: number, reads: boolean) => {
				const type = binaryen.getExpressionType(value);
				if (type === binaryen.unreachable) return value;
				if (!temps.has(type))
					temps.set(type, capi._BinaryenFunctionAddVar(f, type) as number);
				const t = temps.get(type)!;
				return m.block(
					null,
					[
						m.local.set(t, value),
						...(reads ? [frameCall('__folio_f_r', () => l(saved), width)] : []),
						frameCall('__folio_f_w', () => l(saved), width),
						m.local.get(t, type)
					],
					type
				);
			};
			const saver = () => (frame ? (vars(1)[0] as number) : undefined);
			// the pointer operand becomes a block that marks the granules and yields the pointer
			const access = (
				ptr: number,
				offset: number,
				width: number,
				read: boolean,
				write: boolean,
				checks = false,
				saved?: number
			) => {
				if (pointer < 0) [pointer, effective] = vars(2) as [number, number];
				const t = pointer,
					u = effective;
				const steps = [
					m.local.set(t, ptr),
					m.local.set(u, offset ? m.i32.add(l(t), c(offset)) : l(t))
				];
				const tracked: number[] = [];
				const crosses = (shift: number, mark: string) =>
					m.if(
						m.i32.gt_u(m.i32.and(l(u), c((1 << shift) - 1)), c((1 << shift) - width)),
						call(mark, m.i32.add(l(u), c(width - 1)))
					);
				if (read) {
					tracked.push(markRead(() => l(u)));
					if (width > 1) tracked.push(crosses(rg, '__folio_r_mark'));
				}
				if (write) {
					tracked.push(
						m.if(
							unmarked(() => l(u)),
							call('__folio_w_set', l(u))
						)
					);
					if (width > 1) tracked.push(crosses(wg, '__folio_w_mark'));
				}
				const marks = tracked.splice(0);
				if (window)
					tracked.push(
						m.if(m.i32.eqz(inRegion(() => l(u), width)), m.block(null, marks, none))
					);
				else tracked.push(...marks);
				if (frame && checks) tracked.push(frameCall('__folio_f_r', () => l(u), width));
				if (window)
					steps.push(
						m.if(
							m.i32.and(
								m.i32.lt_u(l(u), g(we)),
								m.i32.gt_u(m.i32.add(l(u), c(width)), g(wl))
							),
							m.if(
								within(wl, we, () => l(u), c(width)),
								m.block(
									null,
									[
										m.local.set(t, m.i32.add(l(t), g(wd))),
										m.local.set(u, m.i32.add(l(u), g(wd)))
									],
									none
								),
								m.unreachable()
							)
						)
					);
				const windowed = readWindows > 0 && read && !write && width <= 8;
				const bump = (name: string) => m.global.set(name, m.i32.add(g(name), c(1)));
				// a load that misses every window is tracked, and counted as a miss when counting
				const miss = (inner: number[]) =>
					m.block(null, counting ? [bump(cm), ...inner] : inner, none);
				// a hit inside a window the owner marked in full skips every other step
				const chained = (tail: number) => {
					let chain = tail;
					for (let w = readWindows - 1; w >= 0; w--) {
						const [low, span] = w === 0 ? [r0l, r0m] : [r1l, r1m];
						chain = m.if(
							m.i32.lt_u(m.i32.sub(l(u), g(low)), g(span)),
							counting ? bump(ch) : m.nop(),
							chain
						);
					}
					return chain;
				};
				if (slot) {
					const inner = [
						m.if(
							overlapsArena(() => l(u), c(width)),
							m.if(
								m.i32.eqz(within(sl, se, () => l(u), c(width))),
								call('__folio_x_trap', l(u))
							)
						),
						...tracked
					];
					const exempt = (tail: number) =>
						m.if(
							within(xl, xe, () => l(u), c(width)),
							windowed && counting ? bump(ce) : m.nop(),
							tail
						);
					// the exempt window first, or the windows first: a hit then skips the exempt check
					// and an exempt load pays the guards
					if (!windowed) steps.push(exempt(m.block(null, inner, none)));
					else if (options.exemptFirst) steps.push(exempt(chained(miss(inner))));
					else steps.push(chained(exempt(miss(inner))));
				} else steps.push(...(windowed ? [chained(miss(tracked))] : tracked));
				if (saved !== undefined) steps.push(m.local.set(saved, l(u)));
				steps.push(l(t));
				return m.block(null, steps, i32);
			};
			const visit = (e: number) => {
				const v = info(e);
				for (const child of inlineChildren(v)) visit(child);
				if (
					window &&
					(v.id === binaryen.MemoryCopyId ||
						v.id === binaryen.MemoryFillId ||
						v.id === binaryen.MemoryInitId)
				) {
					// the destination operand evaluates all three, rebases the ranges and marks them;
					// the other operands then read the locals back
					const [td, tm, tn] = vars(3) as [number, number, number];
					const copy = v.id === binaryen.MemoryCopyId;
					const kind = copy ? 'Copy' : v.id === binaryen.MemoryFillId ? 'Fill' : 'Init';
					const middle = copy ? v.source : kind === 'Fill' ? v.value : v.offset;
					const rebase = (local: number) =>
						m.local.set(local, m.call('__folio_w_rebase', [l(local), l(tn)], i32));
					const api = capi as Record<string, (e: number, value: number) => void>;
					api[`_BinaryenMemory${kind}SetDest`]!(
						e,
						m.block(
							null,
							[
								m.local.set(td, v.dest),
								m.local.set(tm, middle),
								m.local.set(tn, v.size),
								rebase(td),
								...(copy
									? [
											rebase(tm),
											call('__folio_x_r_range', l(tm), l(tn)),
											call('__folio_f_rr', l(tm), l(tn))
										]
									: []),
								call('__folio_x_w_range', l(td), l(tn)),
								call('__folio_f_rw', l(td), l(tn)),
								l(td)
							],
							i32
						)
					);
					api[
						`_BinaryenMemory${kind}Set${copy ? 'Source' : kind === 'Fill' ? 'Value' : 'Offset'}`
					]!(e, l(tm));
					api[`_BinaryenMemory${kind}SetSize`]!(e, l(tn));
					return;
				}
				switch (v.id) {
					case binaryen.LoopId:
						if (fuel || stop)
							capi._BinaryenLoopSetBody(
								e,
								m.block(
									null,
									[...(fuel ? [tick()] : []), ...(stop ? [poll()] : []), v.body],
									binaryen.getExpressionType(v.body)
								)
							);
						break;
					case binaryen.LoadId:
						capi._BinaryenLoadSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, Boolean(v.isAtomic), true)
						);
						break;
					case binaryen.StoreId: {
						const saved = saver();
						capi._BinaryenStoreSetPtr(
							e,
							access(
								v.ptr,
								v.offset,
								v.bytes,
								Boolean(v.isAtomic),
								true,
								false,
								saved
							)
						);
						if (saved !== undefined)
							capi._BinaryenStoreSetValue(
								e,
								afterValue(v.value, saved, v.bytes, false)
							);
						break;
					}
					case binaryen.AtomicRMWId: {
						const saved = saver();
						capi._BinaryenAtomicRMWSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, true, false, saved)
						);
						if (saved !== undefined)
							capi._BinaryenAtomicRMWSetValue(
								e,
								afterValue(v.value, saved, v.bytes, true)
							);
						break;
					}
					case binaryen.AtomicCmpxchgId: {
						const saved = saver();
						capi._BinaryenAtomicCmpxchgSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, true, false, saved)
						);
						if (saved !== undefined)
							capi._BinaryenAtomicCmpxchgSetReplacement(
								e,
								afterValue(v.replacement, saved, v.bytes, true)
							);
						break;
					}
					case binaryen.AtomicWaitId:
						capi._BinaryenAtomicWaitSetPtr(
							e,
							access(
								v.ptr,
								0,
								v.expectedType === binaryen.i64 ? 8 : 4,
								true,
								true,
								true
							)
						);
						break;
					case binaryen.AtomicNotifyId:
						capi._BinaryenAtomicNotifySetPtr(e, access(v.ptr, 0, 4, true, true, true));
						break;
					case binaryen.SIMDLoadId:
						capi._BinaryenSIMDLoadSetPtr(
							e,
							access(v.ptr, v.offset, simdLoadBytes.get(v.op)!, true, false, true)
						);
						break;
					case binaryen.SIMDLoadStoreLaneId: {
						const bytes = simdLaneBytes.get(v.op)!;
						const saved = v.isStore ? saver() : undefined;
						capi._BinaryenSIMDLoadStoreLaneSetPtr(
							e,
							access(
								v.ptr,
								v.offset,
								bytes,
								!v.isStore,
								Boolean(v.isStore),
								!v.isStore,
								saved
							)
						);
						if (saved !== undefined)
							capi._BinaryenSIMDLoadStoreLaneSetVec(
								e,
								afterValue(v.vec, saved, bytes, false)
							);
						break;
					}
					case binaryen.MemoryCopyId: {
						const [td, ts, tn] = vars(3) as [number, number, number];
						capi._BinaryenMemoryCopySetDest(e, hold(td, v.dest));
						capi._BinaryenMemoryCopySetSource(e, hold(ts, v.source));
						capi._BinaryenMemoryCopySetSize(
							e,
							m.block(
								null,
								[
									m.local.set(tn, v.size),
									call(
										slot ? '__folio_x_r_range' : '__folio_r_range',
										l(ts),
										l(tn)
									),
									call(
										slot ? '__folio_x_w_range' : '__folio_w_range',
										l(td),
										l(tn)
									),
									...(frame
										? [
												call('__folio_f_rr', l(ts), l(tn)),
												call('__folio_f_rw', l(td), l(tn))
											]
										: []),
									l(tn)
								],
								i32
							)
						);
						break;
					}
					case binaryen.MemoryFillId:
					case binaryen.MemoryInitId: {
						const [td, tn] = vars(2) as [number, number];
						const fill = v.id === binaryen.MemoryFillId;
						capi[fill ? '_BinaryenMemoryFillSetDest' : '_BinaryenMemoryInitSetDest'](
							e,
							hold(td, v.dest)
						);
						capi[fill ? '_BinaryenMemoryFillSetSize' : '_BinaryenMemoryInitSetSize'](
							e,
							m.block(
								null,
								[
									m.local.set(tn, v.size),
									call(
										slot ? '__folio_x_w_range' : '__folio_w_range',
										l(td),
										l(tn)
									),
									...(frame ? [call('__folio_f_rw', l(td), l(tn))] : []),
									l(tn)
								],
								i32
							)
						);
						break;
					}
				}
			};
			visit(body);
			if (fuel)
				capi._BinaryenFunctionSetBody(
					f,
					m.block(null, [tick(), body], binaryen.getExpressionType(body))
				);
		}
		if (fuel) {
			m.addGlobal('__folio_fuel', i32, true, c(0));
			m.addFunctionImport('__folio_exhausted', 'folio', 'exhausted', none, none);
			m.addFunction('__folio_set_fuel', i32, none, [], m.global.set('__folio_fuel', l(0)));
			m.addFunctionExport('__folio_set_fuel', '__folio_set_fuel');
		}
		for (const name of [rb, wb, lp, ll, sa]) {
			m.addGlobal(name, i32, true, c(0));
			m.addGlobalExport(name, name);
		}
		if (frame)
			for (const name of [fl, fn, fs]) {
				m.addGlobal(name, i32, true, c(0));
				m.addGlobalExport(name, name);
			}
		if (slot || window)
			for (const name of [xl, xe, sl, se, al, ae, xv]) {
				m.addGlobal(name, i32, true, c(0));
				m.addGlobalExport(name, name);
			}
		if (window)
			for (const name of [wl, we, wd]) {
				m.addGlobal(name, i32, true, c(0));
				m.addGlobalExport(name, name);
			}
		for (const [index, pair] of [
			[r0l, r0m],
			[r1l, r1m]
		].entries())
			if (index < readWindows)
				for (const name of pair as string[]) {
					m.addGlobal(name, i32, true, c(0));
					m.addGlobalExport(name, name);
				}
		if (summary) {
			m.addGlobal(rs, i32, true, c(0));
			m.addGlobalExport(rs, rs);
		}
		if (counting)
			for (const name of [ch, cm, ce]) {
				m.addGlobal(name, i32, true, c(0));
				m.addGlobalExport(name, name);
			}
		if (stack !== undefined) m.addGlobalExport(stack, inlineGlobals.stackPointer);
		const pair = binaryen.createType([i32, i32]);
		const addFrameHelpers = () => {
			const v = l;
			const max = (a: () => number, b: () => number) =>
				m.select(m.i32.gt_u(a(), b()), a(), b());
			const exposedBase = () =>
				m.i32.add(
					g(fs),
					m.i32.add(m.i32.shl(m.i32.shr_u(m.i32.add(g(fn), c(31)), c(5)), c(2)), c(4))
				);
			// scalar access: params a, w; vars 2 lo, 3 hi, 4 end, 5 i, 6 n, 7 p, 8 miss, 9 q
			const scalar = (name: string, read: boolean) => {
				const mask = () =>
					m.i32.shl(m.i32.sub(m.i32.shl(c(1), v(6)), c(1)), m.i32.and(v(5), c(7)));
				const body = [
					m.local.set(
						2,
						max(
							() => v(0),
							() => g(fl)
						)
					),
					m.local.set(3, m.i32.add(v(0), v(1))),
					m.local.set(4, m.i32.add(g(fl), g(fn))),
					m.if(m.i32.gt_u(v(3), v(4)), m.local.set(3, v(4))),
					m.if(m.i32.le_u(v(3), v(2)), m.return()),
					m.local.set(5, m.i32.sub(v(2), g(fl))),
					m.local.set(6, m.i32.sub(v(3), v(2))),
					m.local.set(7, m.i32.add(g(fs), m.i32.shr_u(v(5), c(3)))),
					...(read
						? [
								m.local.set(
									8,
									m.i32.and(mask(), m.i32.xor(m.i32.load(0, 1, v(7)), c(-1)))
								),
								m.if(
									v(8),
									m.block(
										null,
										[
											m.local.set(
												9,
												m.i32.add(exposedBase(), m.i32.shr_u(v(5), c(3)))
											),
											m.i32.store(
												0,
												1,
												v(9),
												m.i32.or(m.i32.load(0, 1, v(9)), v(8))
											)
										],
										none
									)
								)
							]
						: [m.i32.store(0, 1, v(7), m.i32.or(m.i32.load(0, 1, v(7)), mask()))])
				];
				m.addFunction(name, pair, none, Array(8).fill(i32), m.block(null, body, none));
			};
			scalar('__folio_f_r', true);
			scalar('__folio_f_w', false);
			// range access: params a, n; vars 2 lo, 3 hi, 4 end, 5 i, 6 j, 7 g, 8 last, 9 ms, 10 len,
			// 11 mask, 12 p, 13 miss
			const bulk = (name: string, read: boolean) => {
				const body = [
					m.if(m.i32.eqz(v(1)), m.return()),
					m.local.set(
						2,
						max(
							() => v(0),
							() => g(fl)
						)
					),
					m.local.set(3, m.i32.add(v(0), v(1))),
					m.if(m.i32.lt_u(v(3), v(0)), m.local.set(3, c(-1))),
					m.local.set(4, m.i32.add(g(fl), g(fn))),
					m.if(m.i32.gt_u(v(3), v(4)), m.local.set(3, v(4))),
					m.if(m.i32.le_u(v(3), v(2)), m.return()),
					m.local.set(5, m.i32.sub(v(2), g(fl))),
					m.local.set(6, m.i32.sub(v(3), g(fl))),
					m.local.set(7, m.i32.shr_u(v(5), c(5))),
					m.local.set(8, m.i32.shr_u(m.i32.sub(v(6), c(1)), c(5))),
					m.loop(
						'again',
						m.block(
							null,
							[
								// ms: first byte of the range inside granule g; len: bytes of it inside
								m.local.set(
									9,
									m.i32.sub(
										max(
											() => v(5),
											() => m.i32.shl(v(7), c(5))
										),
										m.i32.shl(v(7), c(5))
									)
								),
								m.local.set(
									10,
									m.i32.sub(
										m.select(
											m.i32.lt_u(
												v(6),
												m.i32.add(m.i32.shl(v(7), c(5)), c(32))
											),
											v(6),
											m.i32.add(m.i32.shl(v(7), c(5)), c(32))
										),
										m.i32.add(m.i32.shl(v(7), c(5)), v(9))
									)
								),
								m.local.set(
									11,
									m.select(
										m.i32.eq(v(10), c(32)),
										c(-1),
										m.i32.shl(m.i32.sub(m.i32.shl(c(1), v(10)), c(1)), v(9))
									)
								),
								m.local.set(12, m.i32.add(g(fs), m.i32.shl(v(7), c(2)))),
								...(read
									? [
											m.local.set(
												13,
												m.i32.and(
													v(11),
													m.i32.xor(m.i32.load(0, 4, v(12)), c(-1))
												)
											),
											m.if(
												v(13),
												m.i32.store(
													0,
													4,
													m.i32.add(
														v(12),
														m.i32.sub(exposedBase(), g(fs))
													),
													m.i32.or(
														m.i32.load(
															0,
															4,
															m.i32.add(
																v(12),
																m.i32.sub(exposedBase(), g(fs))
															)
														),
														v(13)
													)
												)
											)
										]
									: [
											m.i32.store(
												0,
												4,
												v(12),
												m.i32.or(m.i32.load(0, 4, v(12)), v(11))
											)
										]),
								m.local.set(7, m.i32.add(v(7), c(1))),
								m.br('again', m.i32.le_u(v(7), v(8)))
							],
							none
						)
					)
				];
				m.addFunction(name, pair, none, Array(12).fill(i32), m.block(null, body, none));
			};
			bulk('__folio_f_rr', true);
			bulk('__folio_f_rw', false);
		};
		m.addFunction(
			'__folio_r_mark',
			i32,
			none,
			[],
			markRead(() => l(0))
		);
		m.addFunction(
			'__folio_undo',
			i32,
			none,
			[i32],
			m.block(
				null,
				[
					m.if(m.i32.gt_u(m.i32.add(g(lp), c(entry)), g(ll)), m.unreachable()),
					m.local.set(1, g(lp)),
					m.i32.store(0, 4, l(1), l(0)),
					...Array.from({ length: (1 << wg) / 8 }, (_, k) =>
						m.i64.store(8 + 8 * k, 8, l(1), m.i64.load(8 * k, 8, l(0)))
					),
					m.i32.store(4, 4, l(1), m.i32.atomic.rmw.add(0, g(sa), c(1))),
					m.global.set(lp, m.i32.add(l(1), c(entry)))
				],
				none
			)
		);
		m.addFunction(
			'__folio_w_set',
			i32,
			none,
			[],
			m.block(
				null,
				[setBit(wb, () => l(0), wg), call('__folio_undo', m.i32.and(l(0), c(-(1 << wg))))],
				none
			)
		);
		m.addFunction(
			'__folio_w_mark',
			i32,
			none,
			[],
			m.if(
				unmarked(() => l(0)),
				call('__folio_w_set', l(0))
			)
		);
		// every granule from a to a + n - 1
		const range = (name: string, shift: number, mark: string) =>
			m.addFunction(
				name,
				pair,
				none,
				[i32, i32],
				m.if(
					l(1),
					m.block(
						null,
						[
							m.local.set(2, m.i32.shr_u(l(0), c(shift))),
							m.local.set(
								3,
								m.i32.shr_u(m.i32.add(l(0), m.i32.sub(l(1), c(1))), c(shift))
							),
							m.loop(
								'again',
								m.block(
									null,
									[
										call(mark, m.i32.shl(l(2), c(shift))),
										m.local.set(2, m.i32.add(l(2), c(1))),
										m.br('again', m.i32.le_u(l(2), l(3)))
									],
									none
								)
							)
						],
						none
					)
				)
			);
		range('__folio_r_range', rg, '__folio_r_mark');
		range('__folio_w_range', wg, '__folio_w_mark');
		if (frame) addFrameHelpers();
		if (slot || window) {
			m.addFunction(
				'__folio_x_trap',
				i32,
				none,
				[],
				m.block(null, [m.global.set(xv, l(0)), m.unreachable()], none)
			);
			// params a, n; the range is tracked unless it lies in the exempt window
			const exempt = (name: string, tracked: string) =>
				m.addFunction(
					name,
					pair,
					none,
					[i32],
					m.if(
						l(1),
						m.block(
							null,
							[
								m.local.set(2, m.i32.add(l(0), l(1))),
								m.if(
									m.i32.eqz(
										m.i32.and(m.i32.ge_u(l(0), g(xl)), m.i32.le_u(l(2), g(xe)))
									),
									m.block(
										null,
										[
											m.if(
												m.i32.and(
													m.i32.lt_u(l(0), g(ae)),
													m.i32.gt_u(l(2), g(al))
												),
												m.if(
													m.i32.eqz(
														m.i32.and(
															m.i32.ge_u(l(0), g(sl)),
															m.i32.le_u(l(2), g(se))
														)
													),
													call('__folio_x_trap', l(0))
												)
											),
											window
												? m.if(
														m.i32.eqz(
															inRegion(
																() => l(0),
																() => l(1)
															)
														),
														call(tracked, l(0), l(1))
													)
												: call(tracked, l(0), l(1))
										],
										none
									)
								)
							],
							none
						)
					)
				);
			exempt('__folio_x_r_range', '__folio_r_range');
			exempt('__folio_x_w_range', '__folio_w_range');
		}
		if (window) {
			// params a, n, result the address a bulk range runs at: inside the window it moves to the
			// copy, across its edge it traps
			m.addFunction(
				'__folio_w_rebase',
				pair,
				i32,
				[i32],
				m.block(
					null,
					[
						m.if(m.i32.eqz(l(1)), m.return(l(0))),
						m.local.set(2, m.i32.add(l(0), l(1))),
						m.if(m.i32.lt_u(l(2), l(0)), m.return(l(0))),
						m.if(
							m.i32.and(m.i32.lt_u(l(0), g(we)), m.i32.gt_u(l(2), g(wl))),
							m.block(
								null,
								[
									m.if(
										m.i32.and(m.i32.ge_u(l(0), g(wl)), m.i32.le_u(l(2), g(we))),
										m.return(m.i32.add(l(0), g(wd)))
									),
									m.unreachable()
								],
								none
							)
						),
						l(0)
					],
					i32
				)
			);
		}
		if (!m.validate()) throw new Error('invalid inline lowering');
		return m.emitBinary();
	} finally {
		m.dispose();
	}
}
// #endregion

// #region lane module
/**
 * The module a managed lane runs with inline tracking: `lowerInline` with fuel and the arena
 * guard on, and the memory import widened to the largest maximum so a lane can place the marks
 * and the undo log above the program memory. Build time only; the input is the control plan's
 * `workerOriginal`.
 */
export function inlineLane(workerOriginal: Uint8Array): Uint8Array {
	const lowered = lowerInline(workerOriginal, { fuel: true, guard: true });
	const memories = importedMemory(lowered);
	if (memories.length !== 1) throw new Error('exactly one imported memory required');
	return shareMemory(lowered, memories[0]!);
}
// #endregion
