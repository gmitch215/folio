// dynamic guard counter for the paged-memory translation estimate.
// usage: node count-pass.mjs <in.wasm> <out.wasm>
// adds exported mutable i64 globals q_access, q_check, q_call and wraps every load/store,
// memory.copy/fill, call and call_indirect (and every local.set/tee of a base local) in a block
// that bumps them. a base is a local.get, or local.get + const, as in access-bases.mjs.
import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const B = binaryen;
const I32 = B.i32;
const I64 = B.i64;
const NONE = B.none;
const COUNTERS = ['q_access', 'q_check', 'q_call'];
const LEAVES = new Set([
	B.ConstId, B.LocalGetId, B.GlobalGetId, B.NopId, B.UnreachableId,
	B.MemorySizeId, B.RefNullId, B.RefFuncId
]);

const S = (name) => {
	const f = B[`_Binaryen${name}`];
	if (typeof f !== 'function') throw new Error(`binaryen export missing: ${name}`);
	return f;
};
const put = (name, e, ...pre) => (n) => S(name)(e, ...pre, n);
const present = (pairs) => pairs.filter(([c]) => c);

function slotsOf(e, id, I) {
	switch (id) {
		case B.BlockId:
			return I.children.map((c, k) => [c, put('BlockSetChildAt', e, k)]);
		case B.IfId:
			return present([
				[I.condition, put('IfSetCondition', e)],
				[I.ifTrue, put('IfSetIfTrue', e)],
				[I.ifFalse, put('IfSetIfFalse', e)]
			]);
		case B.LoopId:
			return [[I.body, put('LoopSetBody', e)]];
		case B.BreakId:
			return present([
				[I.value, put('BreakSetValue', e)],
				[I.condition, put('BreakSetCondition', e)]
			]);
		case B.SwitchId:
			return present([
				[I.value, put('SwitchSetValue', e)],
				[I.condition, put('SwitchSetCondition', e)]
			]);
		case B.CallId:
			return I.operands.map((c, k) => [c, put('CallSetOperandAt', e, k)]);
		case B.CallIndirectId:
			return [
				...I.operands.map((c, k) => [c, put('CallIndirectSetOperandAt', e, k)]),
				[I.target, put('CallIndirectSetTarget', e)]
			];
		case B.LocalSetId:
			return [[I.value, put('LocalSetSetValue', e)]];
		case B.GlobalSetId:
			return [[I.value, put('GlobalSetSetValue', e)]];
		case B.LoadId:
			return [[I.ptr, put('LoadSetPtr', e)]];
		case B.StoreId:
			return [
				[I.ptr, put('StoreSetPtr', e)],
				[I.value, put('StoreSetValue', e)]
			];
		case B.UnaryId:
			return [[I.value, put('UnarySetValue', e)]];
		case B.BinaryId:
			return [
				[I.left, put('BinarySetLeft', e)],
				[I.right, put('BinarySetRight', e)]
			];
		case B.SelectId:
			return [
				[I.ifTrue, put('SelectSetIfTrue', e)],
				[I.ifFalse, put('SelectSetIfFalse', e)],
				[I.condition, put('SelectSetCondition', e)]
			];
		case B.DropId:
			return [[I.value, put('DropSetValue', e)]];
		case B.ReturnId:
			return present([[I.value, put('ReturnSetValue', e)]]);
		case B.MemoryGrowId:
			return [[I.delta, put('MemoryGrowSetDelta', e)]];
		case B.MemoryCopyId:
			return [
				[I.dest, put('MemoryCopySetDest', e)],
				[I.source, put('MemoryCopySetSource', e)],
				[I.size, put('MemoryCopySetSize', e)]
			];
		case B.MemoryFillId:
			return [
				[I.dest, put('MemoryFillSetDest', e)],
				[I.value, put('MemoryFillSetValue', e)],
				[I.size, put('MemoryFillSetSize', e)]
			];
		default:
			if (LEAVES.has(id)) return [];
			throw new Error(`unhandled expression id ${id}`);
	}
}

function baseOf(p) {
	const id = B.getExpressionId(p);
	if (id === B.LocalGetId) return B.getExpressionInfo(p).index;
	if (id === B.BinaryId) {
		const J = B.getExpressionInfo(p);
		if (B.getExpressionId(J.right) === B.ConstId) return baseOf(J.left);
	}
	return null;
}

function collectBases(e, out) {
	const id = B.getExpressionId(e);
	if (LEAVES.has(id)) return;
	const I = B.getExpressionInfo(e);
	for (const [child] of slotsOf(e, id, I)) collectBases(child, out);
	if (id === B.LoadId || id === B.StoreId) {
		const b = baseOf(I.ptr);
		if (b !== null) out.add(b);
	}
}

// M is the Module instance; the expression builders are Module methods, not binaryen exports.
const inc = (M, g) => M.global.set(g, M.i64.add(M.global.get(g, I64), M.i64.const(1n)));

function rewrite(e, ctx) {
	const M = ctx.mod;
	const id = B.getExpressionId(e);
	if (LEAVES.has(id)) return e;
	const I = B.getExpressionInfo(e);
	for (const [child, setter] of slotsOf(e, id, I)) {
		const n = rewrite(child, ctx);
		if (n !== child) setter(n);
	}
	if (id === B.LoadId || id === B.StoreId) {
		ctx.stats.access++;
		const base = baseOf(I.ptr);
		let check;
		if (base === null) {
			ctx.stats.otherPtr++;
			check = inc(M, 'q_check');
		} else {
			const f = ctx.flags.get(base);
			check = M.if(
				M.i32.eqz(M.local.get(f, I32)),
				M.block(null, [M.local.set(f, M.i32.const(1)), inc(M, 'q_check')], NONE)
			);
		}
		return M.block(null, [inc(M, 'q_access'), check, e], I.type);
	}
	if (id === B.MemoryCopyId || id === B.MemoryFillId) {
		ctx.stats.bulk++;
		return M.block(null, [inc(M, 'q_access'), inc(M, 'q_check'), e], NONE);
	}
	if (id === B.CallId || id === B.CallIndirectId) {
		ctx.stats.calls++;
		return M.block(null, [inc(M, 'q_call'), e], I.type);
	}
	if (id === B.LocalSetId && ctx.flags.has(I.index)) {
		ctx.stats.resets++;
		const reset = M.local.set(ctx.flags.get(I.index), M.i32.const(0));
		if (I.isTee) return M.block(null, [M.drop(e), reset, M.local.get(I.index, I.type)], I.type);
		return M.block(null, [e, reset], NONE);
	}
	return e;
}

// the features the shipping module validates with. Features.All makes binaryen 132 write malformed imports.
const FEATURES = B.Features.MVP | B.Features.SignExt | B.Features.TruncSat | B.Features.Multivalue
	| B.Features.BulkMemory | B.Features.BulkMemoryOpt | B.Features.MutableGlobals;

export function instrument(mod) {
	mod.setFeatures(FEATURES);
	for (const g of COUNTERS) {
		mod.addGlobal(g, I64, true, mod.i64.const(0n));
		mod.addGlobalExport(g, g);
	}
	const stats = { functions: 0, access: 0, otherPtr: 0, bulk: 0, calls: 0, resets: 0 };
	const infos = [];
	for (let f = 0; f < mod.getNumFunctions(); f++) {
		const info = B.getFunctionInfo(mod.getFunctionByIndex(f));
		if (info.body) infos.push(info);
	}
	for (const fn of infos) {
		const bases = new Set();
		collectBases(fn.body, bases);
		const nParams = B.expandType(fn.params).length;
		const first = nParams + fn.vars.length;
		const flags = new Map([...bases].sort((a, b) => a - b).map((l, k) => [l, first + k]));
		const body = rewrite(fn.body, { flags, stats, mod });
		if (body === fn.body && flags.size === 0) continue;
		stats.functions++;
		if (flags.size === 0) {
			S('FunctionSetBody')(mod.getFunction(fn.name), body);
		} else {
			mod.removeFunction(fn.name);
			mod.addFunction(fn.name, fn.params, fn.results, [...fn.vars, ...Array(flags.size).fill(I32)], body);
		}
	}
	return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [inPath, outPath] = process.argv.slice(2);
	const mod = B.readBinary(readFileSync(inPath));
	mod.setFeatures(FEATURES);
	const inputValid = mod.validate();
	const stats = instrument(mod);
	stats.inputValid = inputValid;
	if (!mod.validate()) throw new Error('instrumented module does not validate');
	const bytes = mod.emitBinary();
	writeFileSync(outPath, bytes);
	console.log(JSON.stringify({ ...stats, bytes: bytes.length }));
}
