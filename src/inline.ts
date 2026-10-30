import binaryen from 'binaryen';
import { stackRoute } from './extract.ts';

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
	stackPointer: '__folio_sp'
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
}

const inlineHelpers = [
	'__folio_r_mark',
	'__folio_w_mark',
	'__folio_w_set',
	'__folio_undo',
	'__folio_r_range',
	'__folio_w_range'
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
 * Throws for a module without exactly one memory, a 64-bit memory, an unshared memory when
 * `requireShared` is set, a start function that calls, a reserved name or an expression it does
 * not know. An imported host function that touches memory is not seen.
 */
export function lowerInline(bytes: Uint8Array, options: InlineOptions = {}): Uint8Array {
	const rg = granuleShift(options.readGranule, 64, 16, 4096);
	const wg = granuleShift(options.writeGranule, 32, 16, 256);
	const entry = inlineEntryBytes(1 << wg);
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
		const reserved = [...Object.values(inlineGlobals), ...inlineHelpers];
		if (reserved.some((name) => m.getGlobal(name) || m.getFunction(name) || m.getExport(name)))
			throw new Error('reserved function name');
		if (stack !== undefined) {
			const global = m.getGlobal(stack);
			const shape = global ? binaryen.getGlobalInfo(global) : undefined;
			if (!shape || !shape.mutable || shape.type !== binaryen.i32 || shape.module)
				throw new Error(`stack global ${stack} is not a defined mutable i32`);
		}
		const rb = inlineGlobals.readBitmap,
			wb = inlineGlobals.writeBitmap,
			lp = inlineGlobals.logPointer,
			ll = inlineGlobals.logLimit,
			sa = inlineGlobals.stampAddress;
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
		const unmarked = (address: () => number) =>
			m.i32.eqz(m.i32.and(m.i32.load8_u(0, 1, byteOf(wb, address, wg)), bitOf(address, wg)));
		const hold = (local: number, value: number) =>
			m.block(null, [m.local.set(local, value), l(local)], i32);
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
			// the pointer operand becomes a block that marks the granules and yields the pointer
			const access = (
				ptr: number,
				offset: number,
				width: number,
				read: boolean,
				write: boolean
			) => {
				if (pointer < 0) [pointer, effective] = vars(2) as [number, number];
				const t = pointer,
					u = effective;
				const steps = [
					m.local.set(t, ptr),
					m.local.set(u, offset ? m.i32.add(l(t), c(offset)) : l(t))
				];
				const crosses = (shift: number, mark: string) =>
					m.if(
						m.i32.gt_u(m.i32.and(l(u), c((1 << shift) - 1)), c((1 << shift) - width)),
						call(mark, m.i32.add(l(u), c(width - 1)))
					);
				if (read) {
					steps.push(setBit(rb, () => l(u), rg));
					if (width > 1) steps.push(crosses(rg, '__folio_r_mark'));
				}
				if (write) {
					steps.push(
						m.if(
							unmarked(() => l(u)),
							call('__folio_w_set', l(u))
						)
					);
					if (width > 1) steps.push(crosses(wg, '__folio_w_mark'));
				}
				steps.push(l(t));
				return m.block(null, steps, i32);
			};
			const visit = (e: number) => {
				const v = info(e);
				for (const child of inlineChildren(v)) visit(child);
				switch (v.id) {
					case binaryen.LoadId:
						capi._BinaryenLoadSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, Boolean(v.isAtomic))
						);
						break;
					case binaryen.StoreId:
						capi._BinaryenStoreSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, Boolean(v.isAtomic), true)
						);
						break;
					case binaryen.AtomicRMWId:
						capi._BinaryenAtomicRMWSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, true)
						);
						break;
					case binaryen.AtomicCmpxchgId:
						capi._BinaryenAtomicCmpxchgSetPtr(
							e,
							access(v.ptr, v.offset, v.bytes, true, true)
						);
						break;
					case binaryen.AtomicWaitId:
						capi._BinaryenAtomicWaitSetPtr(
							e,
							access(v.ptr, 0, v.expectedType === binaryen.i64 ? 8 : 4, true, true)
						);
						break;
					case binaryen.AtomicNotifyId:
						capi._BinaryenAtomicNotifySetPtr(e, access(v.ptr, 0, 4, true, true));
						break;
					case binaryen.SIMDLoadId:
						capi._BinaryenSIMDLoadSetPtr(
							e,
							access(v.ptr, v.offset, simdLoadBytes.get(v.op)!, true, false)
						);
						break;
					case binaryen.SIMDLoadStoreLaneId:
						capi._BinaryenSIMDLoadStoreLaneSetPtr(
							e,
							access(
								v.ptr,
								v.offset,
								simdLaneBytes.get(v.op)!,
								!v.isStore,
								Boolean(v.isStore)
							)
						);
						break;
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
									call('__folio_r_range', l(ts), l(tn)),
									call('__folio_w_range', l(td), l(tn)),
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
									call('__folio_w_range', l(td), l(tn)),
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
		}
		for (const name of [rb, wb, lp, ll, sa]) {
			m.addGlobal(name, i32, true, c(0));
			m.addGlobalExport(name, name);
		}
		if (stack !== undefined) m.addGlobalExport(stack, inlineGlobals.stackPointer);
		const pair = binaryen.createType([i32, i32]);
		m.addFunction(
			'__folio_r_mark',
			i32,
			none,
			[],
			setBit(rb, () => l(0), rg)
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
		if (!m.validate()) throw new Error('invalid inline lowering');
		return m.emitBinary();
	} finally {
		m.dispose();
	}
}
// #endregion
