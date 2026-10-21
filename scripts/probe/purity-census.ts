import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// classifies every defined function by the first rule that keeps it out of a worker region
const numeric = new Set([binaryen.i32, binaryen.i64, binaryen.f32, binaryen.f64]);
// the node kinds the extractor lets a worker region contain
const allowed = new Set([
	binaryen.BlockId,
	binaryen.IfId,
	binaryen.LoopId,
	binaryen.BreakId,
	binaryen.SwitchId,
	binaryen.CallId,
	binaryen.LocalGetId,
	binaryen.LocalSetId,
	binaryen.LoadId,
	binaryen.StoreId,
	binaryen.MemoryCopyId,
	binaryen.MemoryFillId,
	binaryen.ConstId,
	binaryen.UnaryId,
	binaryen.BinaryId,
	binaryen.SelectId,
	binaryen.DropId,
	binaryen.ReturnId,
	binaryen.NopId,
	binaryen.UnreachableId
]);
const names: Record<number, string> = {
	[binaryen.GlobalGetId]: 'global.get',
	[binaryen.GlobalSetId]: 'global.set',
	[binaryen.CallIndirectId]: 'call_indirect',
	[binaryen.MemoryGrowId]: 'memory.grow',
	[binaryen.MemorySizeId]: 'memory.size',
	[binaryen.MemoryInitId]: 'memory.init',
	[binaryen.DataDropId]: 'data.drop',
	[binaryen.TableSizeId]: 'table.size'
};
export const children = (v: any): number[] => {
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
		case binaryen.LoadId:
			return [v.ptr];
		case binaryen.StoreId:
			return [v.ptr, v.value];
		case binaryen.BinaryId:
			return [v.left, v.right];
		case binaryen.SelectId:
			return [v.ifTrue, v.ifFalse, v.condition];
		case binaryen.ReturnId:
			return v.value ? [v.value] : [];
		case binaryen.MemoryGrowId:
			return [v.delta];
		case binaryen.MemoryCopyId:
			return [v.dest, v.source, v.size];
		case binaryen.MemoryFillId:
			return [v.dest, v.value, v.size];
		case binaryen.MemoryInitId:
			return [v.dest, v.offset, v.size];
		default:
			return [];
	}
};
interface Row {
	name: string;
	reasons: Set<string>;
	globals: Set<string>;
	targets: Set<string>;
	loops: number;
	stores: number;
	instructions: number;
}
export function census(bytes: Uint8Array, artifact = 'module') {
	const m = binaryen.readBinary(bytes);
	m.setFeatures(binaryen.Features.All);
	const exported = new Map<string, string>();
	for (let i = 0; i < m.getNumExports(); i++) {
		const e = binaryen.getExportInfo(m.getExportByIndex(i));
		if (e.kind === binaryen.ExternalFunction && !exported.has(e.value))
			exported.set(e.value, e.name);
	}
	const rows = new Map<string, Row>();
	let importedFunctions = 0;
	const globalUses = new Map<string, number>();
	for (let i = 0; i < m.getNumFunctions(); i++) {
		const fn = m.getFunctionByIndex(i);
		const f = binaryen.getFunctionInfo(fn);
		if (!f.body) {
			importedFunctions++;
			continue;
		}
		const row: Row = {
			name: f.name,
			reasons: new Set(),
			globals: new Set(),
			targets: new Set(),
			loops: 0,
			stores: 0,
			instructions: 0
		};
		if (![...binaryen.expandType(f.params), ...f.vars].every((t) => numeric.has(t)))
			row.reasons.add('non-numeric local');
		const visit = (e: number) => {
			const v: any =
				binaryen.getExpressionId(e) === binaryen.NopId ||
				binaryen.getExpressionId(e) === binaryen.UnreachableId
					? { id: binaryen.getExpressionId(e), type: binaryen.getExpressionType(e) }
					: binaryen.getExpressionInfo(e);
			row.instructions++;
			if (v.id === binaryen.LoopId) row.loops++;
			if (v.id === binaryen.StoreId) row.stores++;
			if (v.isAtomic) row.reasons.add('atomic');
			else if (names[v.id]) row.reasons.add(names[v.id]!);
			else if (!allowed.has(v.id)) row.reasons.add('other node');
			if (v.id === binaryen.GlobalGetId || v.id === binaryen.GlobalSetId) {
				row.globals.add(v.name);
				globalUses.set(v.name, (globalUses.get(v.name) ?? 0) + 1);
			}
			if (v.id === binaryen.CallId) row.targets.add(v.target);
			if (![binaryen.none, binaryen.unreachable].includes(v.type) && !numeric.has(v.type))
				row.reasons.add('non-numeric value');
			for (const child of children(v)) visit(child);
		};
		try {
			visit(f.body);
		} catch {
			row.reasons.add('unreadable');
		}
		rows.set(f.name, row);
	}
	const stackPointer = [...globalUses].sort((a, b) => b[1] - a[1])[0]?.[0];
	// a call target outside the defined set is an import, which is an effect
	const closure = (tolerated: (row: Row) => boolean) => {
		const pure = new Set(
			[...rows.values()]
				.filter((row) => tolerated(row) && [...row.targets].every((t) => rows.has(t)))
				.map((row) => row.name)
		);
		for (let changed = true; changed;) {
			changed = false;
			for (const name of pure) {
				if ([...rows.get(name)!.targets].some((t) => !pure.has(t))) {
					pure.delete(name);
					changed = true;
				}
			}
		}
		return pure;
	};
	const strict = closure((row) => row.reasons.size === 0 && row.globals.size === 0);
	const withStackOnly = closure((row) => {
		const rest = new Set(row.reasons);
		rest.delete('global.get');
		rest.delete('global.set');
		return rest.size === 0 && [...row.globals].every((g) => g === stackPointer);
	});
	const firstReason = new Map<string, number>();
	for (const row of rows.values()) {
		const reason = row.reasons.size
			? [...row.reasons].filter((r) => !r.startsWith('global.'))[0] ||
				(row.globals.size > 1 ||
				(row.globals.size && ![...row.globals].includes(stackPointer!))
					? 'other global'
					: 'stack pointer')
			: row.globals.size
				? [...row.globals].every((g) => g === stackPointer)
					? 'stack pointer'
					: 'other global'
				: [...row.targets].some((t) => !rows.has(t))
					? 'calls an import'
					: strict.has(row.name)
						? 'pure'
						: 'calls an impure function';
		firstReason.set(reason, (firstReason.get(reason) ?? 0) + 1);
	}
	const labelOf = (row: Row) =>
		strict.has(row.name)
			? 'pure'
			: withStackOnly.has(row.name)
				? 'pure if stack pointer allowed'
				: row.reasons.has('call_indirect')
					? 'call_indirect'
					: row.reasons.size || row.globals.size
						? 'other node or global'
						: 'calls an import or an impure function';
	const labels = [...new Set([...rows.values()].map(labelOf))].sort();
	const functionLabels = Object.fromEntries(
		[...rows.values()].map((row) => [row.name, labels.indexOf(labelOf(row))])
	);
	const loopy = (set: Set<string>) =>
		[...set].filter((n) => rows.get(n)!.loops > 0 && rows.get(n)!.stores > 0).length;
	const result = {
		artifact,
		bytes: bytes.length,
		definedFunctions: rows.size,
		stackPointerGlobal: stackPointer,
		globalUses: Object.fromEntries([...globalUses].sort((a, b) => b[1] - a[1]).slice(0, 8)),
		firstBlockingReason: Object.fromEntries([...firstReason].sort((a, b) => b[1] - a[1])),
		pure: strict.size,
		pureWithLoopAndStore: loopy(strict),
		pureIfStackPointerAllowed: withStackOnly.size,
		pureIfStackPointerAllowedWithLoopAndStore: loopy(withStackOnly),
		importedFunctions,
		labels,
		functionLabels,
		pureNames: [...strict].map((n) => exported.get(n) ?? `fn:${n}`).slice(0, 400)
	};
	m.dispose();
	return result;
}

// usage: node scripts/probe/purity-census.ts MODULE.wasm OUTPUT.json
if (import.meta.main) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) throw new Error('usage: purity-census.ts MODULE.wasm OUTPUT.json');
	const result = census(readFileSync(input), basename(input));
	writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	console.log(
		JSON.stringify({
			...result,
			pureNames: undefined,
			globalUses: undefined,
			functionLabels: undefined
		})
	);
}
