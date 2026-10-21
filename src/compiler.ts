import binaryen from 'binaryen';
import type { AdmissionOptions, ControlPlan } from './extract.ts';
import { admission, extract } from './extract.ts';
import type { NativePlan } from './guards.ts';
import { nativePlan } from './guards.ts';

/** A counted loop the splitter can divide: the count parameter and the affine pointer steps. */
export interface LoopPlan {
	/** Index of the parameter holding the iteration count. */
	countParameter: number;
	/** Pointer parameters that advance by `step` bytes per iteration. */
	steps: { parameter: number; step: number }[];
}

/** The output of `prepare`: the untouched program plus the artifacts workers need. Trusted build artifact. */
export interface PreparedProgram {
	/** The source module bytes; the coordinator runs these unchanged. */
	original: Uint8Array;
	/** Optional precompiled module for hosts that cannot compile at request time. */
	compiled?: WebAssembly.Module;
	/** The tracked worker module that records byte reads and writes. */
	transactional?: Uint8Array;
	/** Counted-loop plans by export name. */
	loops: Record<string, LoopPlan>;
	/** Why an export has no loop plan. */
	loopReasons?: Record<string, string>;
	/** Module-wide reasons optimization was refused. */
	reasons: string[];
	/** Native guard plans by export name. */
	native?: Record<string, NativePlan>;
	/** The generalized control-flow plan, when the module admits one. */
	control?: ControlPlan;
	/** Why control-flow extraction produced no plan; the counted-loop plans above are unaffected. */
	controlReasons?: string[];
}

type Info = ReturnType<typeof binaryen.getExpressionInfo> & Record<string, any>;
const info = (expression: number): Info => {
	const id = binaryen.getExpressionId(expression);
	if (id === binaryen.UnreachableId || id === binaryen.NopId) {
		return { id, type: binaryen.getExpressionType(expression) } as Info;
	}
	return binaryen.getExpressionInfo(expression) as Info;
};

function walk(expression: number, visit: (value: Info) => void): void {
	const value = info(expression);
	visit(value);
	for (const key of ['children', 'operands']) {
		for (const child of value[key] ?? []) walk(child, visit);
	}
	for (const key of [
		'body',
		'condition',
		'ifTrue',
		'ifFalse',
		'ptr',
		'value',
		'left',
		'right',
		'dest',
		'source',
		'size'
	]) {
		if (key === 'value' && value.id === binaryen.ConstId) continue;
		if (typeof value[key] === 'number' && value[key]) walk(value[key], visit);
	}
}

function loopPlan(
	module: binaryen.Module,
	fn: binaryen.FunctionRef,
	diagnostic: { reason: string }
): LoopPlan | undefined {
	const f = binaryen.getFunctionInfo(fn);
	if (f.results !== binaryen.none) {
		diagnostic.reason = 'non-void entry requires a result merge';
		return;
	}
	const parameters = binaryen.expandType(f.params);
	if (parameters.some((type) => type !== binaryen.i32)) {
		diagnostic.reason = 'non-i32 loop parameters';
		return;
	}
	const root = info(f.body);
	if (root.id !== binaryen.BlockId || root.children.length !== 2) return;
	const guard = info(root.children[0]);
	const loop = info(root.children[1]);
	if (
		guard.id !== binaryen.BreakId ||
		guard.name !== root.name ||
		guard.value ||
		!guard.condition
	)
		return;
	if (loop.id !== binaryen.LoopId) return;
	const zero = info(guard.condition);
	if (zero.id !== binaryen.UnaryId || zero.op !== binaryen.EqZInt32) return;
	const counter = info(zero.value);
	if (counter.id !== binaryen.LocalGetId || counter.index >= parameters.length) return;
	const body = info(loop.body);
	if (body.id !== binaryen.BlockId || body.children.length < 2) return;
	const last = info(body.children.at(-1));
	if (last.id !== binaryen.BreakId || last.name !== loop.name || last.value || !last.condition)
		return;
	const decrement = info(last.condition);
	if (decrement.id !== binaryen.LocalSetId || !decrement.isTee) return;
	if (decrement.index !== counter.index) return;
	const add = info(decrement.value);
	if (add.id !== binaryen.BinaryId || add.op !== binaryen.AddInt32) return;
	const left = info(add.left),
		right = info(add.right);
	if (left.id !== binaryen.LocalGetId || left.index !== counter.index) return;
	if (right.id !== binaryen.ConstId || right.value !== -1) return;
	const steps: LoopPlan['steps'] = [];
	const updates = new Set<number>();
	let end = body.children.length - 1;
	while (end > 0) {
		const set = info(body.children[end - 1]);
		if (set.id !== binaryen.LocalSetId || set.isTee || set.index === counter.index) break;
		if (set.index >= parameters.length) break;
		const update = info(set.value);
		if (update.id !== binaryen.BinaryId || update.op !== binaryen.AddInt32) break;
		const source = info(update.left),
			delta = info(update.right);
		if (source.id !== binaryen.LocalGetId || source.index !== set.index) break;
		if (delta.id !== binaryen.ConstId || updates.has(set.index)) break;
		updates.add(set.index);
		steps.push({ parameter: set.index, step: delta.value });
		end--;
	}
	if (!steps.length || end === 0) return;
	const payload = body.children.slice(0, end);
	const written = new Set<number>();
	let safe = true;
	for (const expression of payload) {
		walk(expression, (value) => {
			if (value.id === binaryen.LocalSetId) {
				written.add(value.index);
				if (value.index === counter.index || updates.has(value.index)) {
					diagnostic.reason = 'loop control modified inside the iteration';
					safe = false;
				}
			}
			if (value.id === binaryen.LocalGetId && value.index === counter.index) {
				diagnostic.reason = 'iteration reads the remaining count';
				safe = false;
			}
			if (
				[binaryen.BreakId, binaryen.SwitchId, binaryen.ReturnId, binaryen.LoopId].includes(
					value.id
				) ||
				(value.id === binaryen.CallId && value.isReturn)
			) {
				diagnostic.reason = 'nested or escaping control flow';
				safe = false;
			}
		});
	}
	if (!safe) return;
	function visit(expression: number, assigned: Set<number>): boolean {
		const value = info(expression);
		const children = (...expressions: number[]) =>
			expressions.every((child) => visit(child, assigned));
		switch (value.id) {
			case binaryen.LocalGetId:
				if (written.has(value.index) && !assigned.has(value.index)) {
					diagnostic.reason = 'loop-carried scalar state';
					return false;
				}
				return true;
			case binaryen.LocalSetId:
				if (!visit(value.value, assigned)) return false;
				assigned.add(value.index);
				return true;
			case binaryen.BlockId:
				return children(...value.children);
			case binaryen.IfId: {
				if (!visit(value.condition, assigned)) return false;
				const yes = new Set(assigned),
					no = new Set(assigned);
				if (!visit(value.ifTrue, yes) || (value.ifFalse && !visit(value.ifFalse, no)))
					return false;
				for (const index of yes) if (no.has(index)) assigned.add(index);
				return true;
			}
			case binaryen.SelectId:
				return children(value.ifTrue, value.ifFalse, value.condition);
			case binaryen.CallId:
				return children(...value.operands);
			case binaryen.UnaryId:
			case binaryen.DropId:
				return children(value.value);
			case binaryen.BinaryId:
				return children(value.left, value.right);
			case binaryen.LoadId:
				return children(value.ptr);
			case binaryen.StoreId:
				return children(value.ptr, value.value);
			case binaryen.MemoryCopyId:
				return children(value.dest, value.source, value.size);
			case binaryen.MemoryFillId:
				return children(value.dest, value.value, value.size);
			case binaryen.ConstId:
			case binaryen.GlobalGetId:
			case binaryen.NopId:
			case binaryen.UnreachableId:
				return true;
			default:
				diagnostic.reason = 'iteration analysis does not support this expression';
				return false;
		}
	}
	const assigned = new Set<number>();
	return payload.every((expression: number) => visit(expression, assigned))
		? { countParameter: counter.index, steps }
		: undefined;
}

/** Prepares guarded parallel paths; unsupported features retain the original module. */
function prepareTracked(
	bytes: Uint8Array,
	options: { parallel?: 'auto' | 'off' } = {}
): PreparedProgram {
	const original = Uint8Array.from(bytes);
	const native = new WebAssembly.Module(original);
	if (options.parallel === 'off')
		return { original, loops: {}, reasons: ['parallel preparation disabled'] };
	const reasons: string[] = [];
	const imports = WebAssembly.Module.imports(native);
	if (imports.some((item) => item.kind !== 'memory')) reasons.push('host or non-memory imports');
	if (imports.some((item) => item.module === 'folio')) reasons.push('reserved import namespace');
	if (imports.filter((item) => item.kind === 'memory').length !== 1)
		reasons.push('one imported memory required');
	let cursor = 8;
	const unsigned = (): number => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = original[cursor++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	while (cursor < original.length) {
		const section = original[cursor++]!;
		const size = unsigned();
		const end = cursor + size;
		if (section === 5 && unsigned() !== 0) reasons.push('additional defined memory');
		cursor = end;
	}
	if (reasons.length) return { original, loops: {}, reasons };
	let analysisModule: binaryen.Module | undefined;
	const loops: PreparedProgram['loops'] = {};
	const loopReasons: Record<string, string> = {};
	const nativePlans: Record<string, NativePlan> = {};
	try {
		const module = (analysisModule = binaryen.readBinary(original));
		// Native validation already established the source instruction set. Binaryen
		// does not infer every proposal flag from a binary's instruction bodies.
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		module.setFeatures(binaryen.Features.All & ~compactImports);
		if (module.getStart()) reasons.push('start function');
		const raw = module as binaryen.Module & { getNumDataSegments(): number };
		if (raw.getNumDataSegments())
			reasons.push('data segments require initialization isolation');
		const memory = module.hasMemory() ? module.getMemoryInfo() : undefined;
		if (!memory?.shared || memory.is64) reasons.push('shared wasm32 memory required');
		if (memory?.shared) module.setFeatures(module.getFeatures() | binaryen.Features.Atomics);
		const allowed = new Set([
			binaryen.BlockId,
			binaryen.IfId,
			binaryen.LoopId,
			binaryen.BreakId,
			binaryen.SwitchId,
			binaryen.CallId,
			binaryen.LocalGetId,
			binaryen.LocalSetId,
			binaryen.GlobalGetId,
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
		const calls = new Map<string, Set<string>>();
		const exportedFunctions = new Map<string, string[]>();
		for (let index = 0; index < module.getNumExports(); index++) {
			const exported = binaryen.getExportInfo(module.getExportByIndex(index));
			if (exported.kind !== binaryen.ExternalFunction) continue;
			const names = exportedFunctions.get(exported.value) ?? [];
			names.push(exported.name);
			exportedFunctions.set(exported.value, names);
		}
		for (let index = 0; index < module.getNumFunctions(); index++) {
			const fn = module.getFunctionByIndex(index);
			const f = binaryen.getFunctionInfo(fn);
			if (
				[...binaryen.expandType(f.params), ...binaryen.expandType(f.results)].some(
					(type) =>
						![binaryen.i32, binaryen.i64, binaryen.f32, binaryen.f64].includes(type)
				)
			)
				reasons.push('reference or vector function signature');
			if (!f.body) continue;
			const targets = new Set<string>();
			calls.set(f.name, targets);
			walk(f.body, (value) => {
				if (value.id === binaryen.CallId) targets.add(value.target);
				if (!allowed.has(value.id)) reasons.push(`unsupported expression ${value.id}`);
				if (value.id === binaryen.GlobalGetId) reasons.push('global state');
				if (value.isAtomic) reasons.push('atomic access');
				if ([binaryen.LoadId, binaryen.StoreId].includes(value.id)) {
					const type = value.id === binaryen.LoadId ? value.type : info(value.value).type;
					if (![binaryen.i32, binaryen.i64, binaryen.f32, binaryen.f64].includes(type))
						reasons.push('unsupported memory value type');
				}
			});
			const diagnostic = { reason: 'loop shape not recognized' };
			const plan = loopPlan(module, fn, diagnostic);
			const names = exportedFunctions.get(f.name) ?? [];
			const proved = names.length && plan ? nativePlan(module, fn) : undefined;
			for (const name of names) {
				if (plan) {
					Object.defineProperty(loops, name, {
						value: plan,
						enumerable: true,
						configurable: true,
						writable: true
					});
					if (proved)
						Object.defineProperty(nativePlans, name, {
							value: proved,
							enumerable: true,
							configurable: true,
							writable: true
						});
				} else
					Object.defineProperty(loopReasons, name, {
						value: diagnostic.reason,
						enumerable: true,
						configurable: true,
						writable: true
					});
			}
		}
		const visiting = new Set<string>(),
			visited = new Set<string>();
		const recursive = (name: string): boolean => {
			if (visiting.has(name)) return true;
			if (visited.has(name)) return false;
			visiting.add(name);
			if ([...(calls.get(name) ?? [])].some(recursive)) return true;
			visiting.delete(name);
			visited.add(name);
			return false;
		};
		if ([...calls.keys()].some(recursive))
			reasons.push('recursive call graph retains original owner stack');
		if (reasons.length) return { original, loops: {}, reasons: [...new Set(reasons)] };
		const reserved = [
			'__folio_load',
			'__folio_store',
			'__folio_exhausted',
			'__folio_set_fuel',
			'__folio_load64',
			'__folio_store64',
			'__folio_copy',
			'__folio_fill'
		];
		if (
			reserved.some((name) => module.getFunction(name) || module.getExport(name)) ||
			module.getGlobal('__folio_fuel')
		) {
			return { original, loops: {}, reasons: ['reserved function name'] };
		}
		module.addGlobal('__folio_fuel', binaryen.i32, true, module.i32.const(0));
		const lowered = module;
		function tick(): number {
			const module = lowered;
			return module.block(null, [
				module.global.set(
					'__folio_fuel',
					module.i32.sub(
						module.global.get('__folio_fuel', binaryen.i32),
						module.i32.const(1)
					)
				),
				module.if(
					module.i32.le_s(
						module.global.get('__folio_fuel', binaryen.i32),
						module.i32.const(0)
					),
					module.call(reserved[2]!, [], binaryen.none)
				)
			]);
		}
		function lower(expression: number): number {
			const module = lowered;
			const v = info(expression);
			switch (v.id) {
				case binaryen.BlockId:
					return module.block(v.name, v.children.map(lower), v.type);
				case binaryen.IfId:
					return module.if(
						lower(v.condition),
						lower(v.ifTrue),
						v.ifFalse ? lower(v.ifFalse) : undefined
					);
				case binaryen.LoopId:
					return module.loop(v.name, module.block(null, [tick(), lower(v.body)], v.type));
				case binaryen.BreakId:
					return module.br(
						v.name,
						v.condition ? lower(v.condition) : undefined,
						v.value ? lower(v.value) : undefined
					);
				case binaryen.SwitchId:
					return module.switch(
						v.names,
						v.defaultName,
						lower(v.condition),
						v.value ? lower(v.value) : undefined
					);
				case binaryen.CallId:
					return v.isReturn
						? module.return_call(v.target, v.operands.map(lower), v.type)
						: module.call(v.target, v.operands.map(lower), v.type);
				case binaryen.LocalSetId:
					return v.isTee
						? module.local.tee(v.index, lower(v.value), v.type)
						: module.local.set(v.index, lower(v.value));
				case binaryen.LoadId: {
					const wide = v.type === binaryen.i64 || v.type === binaryen.f64;
					const loaded = module.call(
						reserved[wide ? 4 : 0]!,
						[
							lower(v.ptr),
							module.i32.const(v.offset),
							module.i32.const(v.bytes),
							module.i32.const(Number(v.isSigned))
						],
						wide ? binaryen.i64 : binaryen.i32
					);
					return v.type === binaryen.f32
						? module.f32.reinterpret(loaded)
						: v.type === binaryen.f64
							? module.f64.reinterpret(loaded)
							: loaded;
				}
				case binaryen.StoreId: {
					const type = info(v.value).type;
					const wide = type === binaryen.i64 || type === binaryen.f64;
					const value = lower(v.value);
					return module.call(
						reserved[wide ? 5 : 1]!,
						[
							lower(v.ptr),
							type === binaryen.f32
								? module.i32.reinterpret(value)
								: type === binaryen.f64
									? module.i64.reinterpret(value)
									: value,
							module.i32.const(v.offset),
							module.i32.const(v.bytes)
						],
						binaryen.none
					);
				}
				case binaryen.MemoryCopyId:
					return module.call(
						reserved[6]!,
						[lower(v.dest), lower(v.source), lower(v.size)],
						binaryen.none
					);
				case binaryen.MemoryFillId:
					return module.call(
						reserved[7]!,
						[lower(v.dest), lower(v.value), lower(v.size)],
						binaryen.none
					);
				case binaryen.UnaryId:
					return (binaryen as any)._BinaryenUnary(module.ptr, v.op, lower(v.value));
				case binaryen.BinaryId:
					return (binaryen as any)._BinaryenBinary(
						module.ptr,
						v.op,
						lower(v.left),
						lower(v.right)
					);
				case binaryen.SelectId:
					return module.select(lower(v.condition), lower(v.ifTrue), lower(v.ifFalse));
				case binaryen.DropId:
					return module.drop(lower(v.value));
				case binaryen.ReturnId:
					return module.return(v.value ? lower(v.value) : undefined);
				default:
					return expression;
			}
		}
		const count = module.getNumFunctions();
		for (let index = 0; index < count; index++) {
			const fn = module.getFunctionByIndex(index);
			const body = binaryen.getFunctionInfo(fn).body;
			if (body)
				(binaryen as any)._BinaryenFunctionSetBody(
					fn,
					module.block(null, [tick(), lower(body)], info(body).type)
				);
		}
		const fourI32 = binaryen.createType(Array(4).fill(binaryen.i32));
		module.addFunctionImport(reserved[0]!, 'folio', 'load', fourI32, binaryen.i32);
		module.addFunctionImport(reserved[1]!, 'folio', 'store', fourI32, binaryen.none);
		module.addFunctionImport(reserved[4]!, 'folio', 'load64', fourI32, binaryen.i64);
		module.addFunctionImport(
			reserved[5]!,
			'folio',
			'store64',
			binaryen.createType([binaryen.i32, binaryen.i64, binaryen.i32, binaryen.i32]),
			binaryen.none
		);
		const threeI32 = binaryen.createType(Array(3).fill(binaryen.i32));
		module.addFunctionImport(reserved[6]!, 'folio', 'copy', threeI32, binaryen.none);
		module.addFunctionImport(reserved[7]!, 'folio', 'fill', threeI32, binaryen.none);
		module.addFunctionImport(reserved[2]!, 'folio', 'exhausted', binaryen.none, binaryen.none);
		module.addFunction(
			reserved[3]!,
			binaryen.i32,
			binaryen.none,
			[],
			module.global.set('__folio_fuel', module.local.get(0, binaryen.i32))
		);
		module.addFunctionExport(reserved[3]!, reserved[3]!);
		if (!module.validate()) throw new Error('invalid transactional lowering');
		return {
			original,
			transactional: module.emitBinary(),
			loops,
			loopReasons,
			native: nativePlans,
			reasons: []
		};
	} catch (error) {
		return {
			original,
			loops: {},
			reasons: [
				`parallel preparation unavailable: ${error instanceof Error ? error.message : String(error)}`
			]
		};
	} finally {
		analysisModule?.dispose();
	}
}

/** Plan options: whether to optimize, and when a region is worth dispatching. */
export interface PrepareOptions extends AdmissionOptions {
	/** `off` keeps the original module with no plan. */
	parallel?: 'auto' | 'off';
}

/**
 * Keeps the original native module and adds independently validated optimizations. A module
 * with no region above `minimumRegionWork` gets no control plan and runs untouched.
 */
export function prepare(bytes: Uint8Array, options: PrepareOptions = {}): PreparedProgram {
	admission(options);
	const prepared = prepareTracked(bytes, options);
	if (options.parallel !== 'off') {
		try {
			prepared.control = extract(prepared.original, prepareTracked, {
				minimumRegionWork: options.minimumRegionWork,
				assumedTripCount: options.assumedTripCount,
				refused: (reason) => (prepared.controlReasons ??= []).push(reason)
			});
		} catch (error) {
			prepared.reasons.push(
				`control-flow extraction unavailable: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return prepared;
}
