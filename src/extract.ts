import binaryen from 'binaryen';

export interface ControlPlan {
	coordinator: Uint8Array;
	workerOriginal: Uint8Array;
	transactional: Uint8Array;
	namespace: string;
	serialGlobal: string;
	memoryExport: string;
	shared: boolean;
	initial: number;
	maximum: number;
	entries: string[];
	regions: {
		importName: string;
		exportName: string;
		parameters: ('i32' | 'i64')[];
	}[];
	diagnostics: string[];
}

type Info = ReturnType<typeof binaryen.getExpressionInfo> & Record<string, any>;
type FunctionInfo = ReturnType<typeof binaryen.getFunctionInfo>;
const raw = binaryen as any;
const numeric = new Set([binaryen.i32, binaryen.i64, binaryen.f32, binaryen.f64]);

function info(expression: number): Info {
	const id = binaryen.getExpressionId(expression);
	if (id === binaryen.NopId || id === binaryen.UnreachableId)
		return { id, type: binaryen.getExpressionType(expression) } as Info;
	return binaryen.getExpressionInfo(expression) as Info;
}

function children(v: Info): number[] {
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
}

function memoryCount(bytes: Uint8Array): number {
	let cursor = 8;
	const uint = () => {
		let result = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			result += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return result;
	};
	let defined = 0;
	while (cursor < bytes.length) {
		const section = bytes[cursor++]!;
		const length = uint();
		const end = cursor + length;
		if (section === 5) defined = uint();
		cursor = end;
	}
	return (
		defined +
		WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(bytes))).filter(
			(value) => value.kind === 'memory'
		).length
	);
}

function memoryName(module: binaryen.Module): string {
	for (let i = 0; i < module.getNumExports(); i++) {
		const exported = binaryen.getExportInfo(module.getExportByIndex(i));
		if (exported.kind === binaryen.ExternalMemory) return exported.value;
	}
	const token = /\(memory\s+(\$(?:"(?:\\.|[^"\\])*"|[^\s()]+))/.exec(module.emitText())?.[1];
	if (!token) throw new Error('missing memory name');
	if (token[1] !== '"') return token.slice(1);
	const bytes: number[] = [];
	const content = token.slice(2, -1);
	for (let i = 0; i < content.length;) {
		if (content[i] === '\\') {
			bytes.push(Number.parseInt(content.slice(i + 1, i + 3), 16));
			i += 3;
		} else {
			const point = content.codePointAt(i)!;
			bytes.push(...new TextEncoder().encode(String.fromCodePoint(point)));
			i += point > 65535 ? 2 : 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

export function extract(
	original: Uint8Array,
	prepareTracked: (bytes: Uint8Array) => { transactional?: Uint8Array }
): ControlPlan | undefined {
	let module: binaryen.Module | undefined;
	let worker: binaryen.Module | undefined;
	try {
		if (memoryCount(original) !== 1) return;
		module = binaryen.readBinary(original);
		const memory = module.getMemoryInfo();
		if (memory.is64) return;
		const m = module;
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		m.setFeatures(binaryen.Features.All & ~compactImports);
		const internalMemory = memoryName(m);
		const functions = new Map<string, FunctionInfo>();
		const supported = new Set([
			binaryen.BlockId,
			binaryen.IfId,
			binaryen.LoopId,
			binaryen.BreakId,
			binaryen.SwitchId,
			binaryen.CallId,
			binaryen.CallIndirectId,
			binaryen.LocalGetId,
			binaryen.LocalSetId,
			binaryen.GlobalGetId,
			binaryen.GlobalSetId,
			binaryen.LoadId,
			binaryen.StoreId,
			binaryen.MemoryCopyId,
			binaryen.MemoryFillId,
			binaryen.MemoryInitId,
			binaryen.DataDropId,
			binaryen.MemorySizeId,
			binaryen.MemoryGrowId,
			binaryen.TableSizeId,
			binaryen.ConstId,
			binaryen.UnaryId,
			binaryen.BinaryId,
			binaryen.SelectId,
			binaryen.DropId,
			binaryen.ReturnId,
			binaryen.NopId,
			binaryen.UnreachableId
		]);
		const pureNodes = new Set([
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
		let outlineIndex = 0;
		const originals = Array.from({ length: m.getNumFunctions() }, (_, index) =>
			binaryen.getFunctionInfo(m.getFunctionByIndex(index))
		);
		const originalBodies = new Map(
			originals.filter((f) => f.body).map((f) => [f.name, m.copyExpression(f.body)])
		);
		for (const f of originals) {
			if (!f.body) continue;
			const localTypes = [...binaryen.expandType(f.params), ...f.vars];
			if (!localTypes.every((type) => numeric.has(type))) continue;
			const totalReads = new Map<number, number>();
			let traversable = true;
			const count = (expression: number): void => {
				const v = info(expression);
				if (!supported.has(v.id)) traversable = false;
				if (v.id === binaryen.LocalGetId)
					totalReads.set(v.index, (totalReads.get(v.index) ?? 0) + 1);
				for (const child of children(v)) count(child);
			};
			try {
				count(f.body);
			} catch {
				traversable = false;
			}
			if (!traversable) continue;
			type Span = {
				expression: number;
				reads: Map<number, number>;
				writes: Set<number>;
				locals: Set<number>;
				memoryWrite: boolean;
				compute: boolean;
			};
			const summarize = (expression: number): Span | undefined => {
				const span: Span = {
					expression,
					reads: new Map(),
					writes: new Set(),
					locals: new Set(),
					memoryWrite: false,
					compute: false
				};
				const labels = new Set<string>();
				const targets: string[] = [];
				let eligible = info(expression).type === binaryen.none;
				const visit = (e: number): void => {
					const v = info(e);
					if (
						!pureNodes.has(v.id) ||
						v.isAtomic ||
						v.id === binaryen.CallId ||
						v.id === binaryen.ReturnId
					)
						eligible = false;
					if (
						![binaryen.none, binaryen.unreachable].includes(v.type) &&
						!numeric.has(v.type)
					)
						eligible = false;
					if ((v.id === binaryen.BlockId || v.id === binaryen.LoopId) && v.name)
						labels.add(v.name);
					if (v.id === binaryen.BreakId) targets.push(v.name);
					if (v.id === binaryen.SwitchId) targets.push(...v.names, v.defaultName);
					if (v.id === binaryen.LocalGetId) {
						span.locals.add(v.index);
						span.reads.set(v.index, (span.reads.get(v.index) ?? 0) + 1);
					}
					if (v.id === binaryen.LocalSetId) {
						span.locals.add(v.index);
						span.writes.add(v.index);
					}
					if (
						[binaryen.StoreId, binaryen.MemoryCopyId, binaryen.MemoryFillId].includes(
							v.id
						)
					)
						span.memoryWrite = true;
					if (
						[
							binaryen.LoopId,
							binaryen.IfId,
							binaryen.BinaryId,
							binaryen.UnaryId
						].includes(v.id)
					)
						span.compute = true;
					for (const child of children(v)) visit(child);
				};
				visit(expression);
				return eligible && targets.every((target) => labels.has(target)) ? span : undefined;
			};
			const outline = (spans: Span[]): number[] => {
				const reads = new Map<number, number>();
				const writes = new Set<number>();
				for (const span of spans) {
					for (const [index, amount] of span.reads)
						reads.set(index, (reads.get(index) ?? 0) + amount);
					for (const index of span.writes) writes.add(index);
				}
				const carried = new Set(
					[...writes].filter(
						(index) => (totalReads.get(index) ?? 0) !== (reads.get(index) ?? 0)
					)
				);
				const exits = new Map<string, Set<number>[]>();
				const intersect = (paths: Set<number>[]): Set<number> | undefined =>
					paths.length
						? new Set(
								[...paths[0]!].filter((index) =>
									paths.every((path) => path.has(index))
								)
							)
						: undefined;
				const flow = (
					expression: number,
					incoming: Set<number>
				): Set<number> | undefined => {
					const v = info(expression);
					let assigned: Set<number> | undefined = new Set(incoming);
					if (
						v.id === binaryen.LocalGetId &&
						writes.has(v.index) &&
						!assigned.has(v.index)
					)
						carried.add(v.index);
					if (v.id === binaryen.IfId) {
						assigned = flow(v.condition, assigned);
						if (!assigned) return;
						return intersect(
							[
								flow(v.ifTrue, assigned),
								v.ifFalse ? flow(v.ifFalse, assigned) : assigned
							].filter((path): path is Set<number> => path !== undefined)
						);
					}
					if (v.id === binaryen.BlockId || v.id === binaryen.LoopId) {
						if (v.name) exits.set(v.name, []);
						for (const child of children(v)) {
							if (!assigned) break;
							assigned = flow(child, assigned);
						}
						const branches = v.name ? exits.get(v.name)! : [];
						if (v.name) exits.delete(v.name);
						return intersect([
							...(assigned ? [assigned] : []),
							...(v.id === binaryen.BlockId ? branches : [])
						]);
					}
					for (const child of children(v)) {
						if (!assigned) return;
						assigned = flow(child, assigned);
					}
					if (!assigned) return;
					if (v.id === binaryen.LocalSetId) assigned.add(v.index);
					if (v.id === binaryen.BreakId || v.id === binaryen.SwitchId) {
						const targets =
							v.id === binaryen.SwitchId ? [...v.names, v.defaultName] : [v.name];
						for (const target of targets) exits.get(target)?.push(new Set(assigned));
						if (v.id === binaryen.SwitchId || !v.condition) return;
					}
					return v.id === binaryen.UnreachableId ? undefined : assigned;
				};
				let assigned: Set<number> | undefined = new Set();
				for (const span of spans) {
					if (!assigned) break;
					assigned = flow(span.expression, assigned);
				}
				if (carried.size) {
					const result: number[] = [];
					let pending: Span[] = [];
					for (const span of spans) {
						if ([...span.writes].some((index) => carried.has(index))) {
							if (pending.length) result.push(...outline(pending));
							pending = [];
							result.push(span.expression);
						} else pending.push(span);
					}
					if (pending.length) result.push(...outline(pending));
					return result;
				}
				if (!spans.some((span) => span.memoryWrite) || !spans.some((span) => span.compute))
					return spans.map((span) => span.expression);
				const captured = [...new Set(spans.flatMap((span) => [...span.locals]))].sort(
					(a, b) => a - b
				);
				const positions = new Map(captured.map((index, position) => [index, position]));
				const body = m.block(
					null,
					spans.map((span) => m.copyExpression(span.expression))
				);
				const remap = (expression: number): void => {
					const v = info(expression);
					if (v.id === binaryen.LocalGetId)
						raw._BinaryenLocalGetSetIndex(expression, positions.get(v.index)!);
					if (v.id === binaryen.LocalSetId)
						raw._BinaryenLocalSetSetIndex(expression, positions.get(v.index)!);
					for (const child of children(v)) remap(child);
				};
				remap(body);
				let name: string;
				do {
					name = `__folio_inline_${outlineIndex++}`;
				} while (m.getFunction(name));
				m.addFunction(
					name,
					binaryen.createType(captured.map((index) => localTypes[index]!)),
					binaryen.none,
					[],
					body
				);
				return [
					m.call(
						name,
						captured.map((index) => m.local.get(index, localTypes[index]!)),
						binaryen.none
					)
				];
			};
			const rewrite = (expression: number): void => {
				const v = info(expression);
				for (const child of children(v)) rewrite(child);
				if (v.id !== binaryen.BlockId) return;
				const current = info(expression).children as number[];
				const rewritten: number[] = [];
				let pending: Span[] = [];
				for (const child of current) {
					const span = summarize(child);
					if (span) pending.push(span);
					else {
						if (pending.length) rewritten.push(...outline(pending));
						pending = [];
						rewritten.push(child);
					}
				}
				if (pending.length) rewritten.push(...outline(pending));
				for (let i = current.length - 1; i >= 0; i--)
					raw._BinaryenBlockRemoveChildAt(expression, i);
				for (const child of rewritten) raw._BinaryenBlockAppendChild(expression, child);
			};
			rewrite(f.body);
		}
		for (let i = 0; i < m.getNumFunctions(); i++) {
			const f = binaryen.getFunctionInfo(m.getFunctionByIndex(i));
			functions.set(f.name, f);
		}
		const controllers = new Set<string>();
		const pure = new Set<string>();
		const calls = new Map<string, Set<string>>();
		const diagnostics: string[] = [];
		for (const f of functions.values()) {
			if (!f.body) continue;
			let control =
				[...binaryen.expandType(f.params), ...f.vars].every((t) => numeric.has(t)) &&
				(f.results === binaryen.none || numeric.has(f.results));
			let candidate = control;
			const targets = new Set<string>();
			const visit = (expression: number): void => {
				const v = info(expression);
				if (!supported.has(v.id)) control = false;
				if (!pureNodes.has(v.id) || v.isAtomic) candidate = false;
				if (
					![binaryen.none, binaryen.unreachable].includes(v.type) &&
					!numeric.has(v.type)
				) {
					control = false;
					candidate = false;
				}
				if (v.id === binaryen.CallId) {
					targets.add(v.target);
					if (v.operands.some((e: number) => !numeric.has(info(e).type))) control = false;
				}
				if (
					v.id === binaryen.CallIndirectId &&
					children(v).some((e) => !numeric.has(info(e).type))
				)
					control = false;
				for (const child of children(v)) visit(child);
			};
			try {
				visit(f.body);
			} catch {
				control = candidate = false;
			}
			calls.set(f.name, targets);
			if (control) controllers.add(f.name);
			else diagnostics.push(`ordered native function: ${f.name}`);
			if (candidate && control) pure.add(f.name);
		}
		const indexes = new Map<string, number>();
		const lowlinks = new Map<string, number>();
		const stack: string[] = [];
		const active = new Set<string>();
		const recursive = new Set<string>();
		const components = (name: string): void => {
			indexes.set(name, indexes.size);
			lowlinks.set(name, indexes.get(name)!);
			stack.push(name);
			active.add(name);
			for (const target of calls.get(name) ?? []) {
				if (!calls.has(target)) continue;
				if (!indexes.has(target)) {
					components(target);
					lowlinks.set(name, Math.min(lowlinks.get(name)!, lowlinks.get(target)!));
				} else if (active.has(target))
					lowlinks.set(name, Math.min(lowlinks.get(name)!, indexes.get(target)!));
			}
			if (lowlinks.get(name) !== indexes.get(name)) return;
			const component: string[] = [];
			let member: string;
			do {
				member = stack.pop()!;
				active.delete(member);
				component.push(member);
			} while (member !== name);
			if (component.length > 1 || calls.get(name)?.has(name))
				for (const member of component) recursive.add(member);
		};
		for (const name of calls.keys()) if (!indexes.has(name)) components(name);
		for (const name of recursive) {
			controllers.delete(name);
			pure.delete(name);
			diagnostics.push(`ordered native recursion: ${name}`);
		}
		for (let changed = true; changed;) {
			changed = false;
			for (const name of pure) {
				if ([...calls.get(name)!].some((target) => !pure.has(target))) {
					pure.delete(name);
					changed = true;
				}
			}
		}
		for (const f of originals) {
			if (f.body && !controllers.has(f.name))
				raw._BinaryenFunctionSetBody(m.getFunction(f.name), originalBodies.get(f.name)!);
		}
		if (!pure.size) return;
		let namespace = '__folio_control';
		const imported = WebAssembly.Module.imports(
			new WebAssembly.Module(Uint8Array.from(original))
		);
		while (imported.some((item) => item.module === namespace)) namespace += '_';
		let serial = '__folio_control_serial';
		while (m.getGlobal(serial)) serial += '_';
		let memoryExport = '__folio_control_memory';
		while (m.getExport(memoryExport)) memoryExport += '_';
		const unique = (stem: string) => {
			let name = stem;
			while (m.getFunction(name) || m.getExport(name)) name += '_';
			return name;
		};
		const barrier = unique('__folio_control_barrier');
		m.addFunctionImport(barrier, namespace, 'barrier', binaryen.none, binaryen.none);
		const poll = unique('__folio_control_poll');
		m.addFunctionImport(poll, namespace, 'poll', binaryen.none, binaryen.none);
		m.addGlobalImport(serial, namespace, 'serial', binaryen.i32, true);
		m.addMemoryExport(internalMemory, memoryExport);
		worker = new binaryen.Module();
		const w = worker;
		const maximum = memory.max ?? 65536;
		w.setFeatures(m.getFeatures() | binaryen.Features.Atomics);
		w.setMemory(memory.initial, maximum, null, [], true, false, internalMemory);
		w.addMemoryImport(internalMemory, 'env', 'memory', true);
		for (const name of pure) {
			const f = functions.get(name)!;
			w.addFunction(name, f.params, f.results, f.vars, w.copyExpression(f.body));
		}
		for (let i = 0; i < m.getNumExports(); i++) {
			const exported = binaryen.getExportInfo(m.getExportByIndex(i));
			if (exported.kind === binaryen.ExternalFunction && pure.has(exported.value))
				w.addFunctionExport(exported.value, exported.name);
		}
		const regions: ControlPlan['regions'] = [];
		const enqueueFor = new Map<string, string>();
		for (const name of pure) {
			const f = functions.get(name)!;
			const params = binaryen.expandType(f.params);
			const encoded = params.map((t) =>
				t === binaryen.i64 || t === binaryen.f64 ? binaryen.i64 : binaryen.i32
			);
			const exportName = unique(`__folio_region_${regions.length}`);
			const importName = `region_${regions.length}`;
			const descriptor = {
				importName,
				exportName,
				parameters: encoded.map((t) =>
					t === binaryen.i64 ? ('i64' as const) : ('i32' as const)
				)
			};
			regions.push(descriptor);
			const wrapper = (target: binaryen.Module) => {
				const args = params.map((t, i) => {
					const value = target.local.get(i, encoded[i]!);
					return t === binaryen.f32
						? target.f32.reinterpret(value)
						: t === binaryen.f64
							? target.f64.reinterpret(value)
							: value;
				});
				const call = target.call(name, args, f.results);
				target.addFunction(
					exportName,
					binaryen.createType(encoded),
					binaryen.none,
					[],
					f.results === binaryen.none ? call : target.drop(call)
				);
				target.addFunctionExport(exportName, exportName);
			};
			wrapper(m);
			wrapper(w);
			const enqueue = unique(`__folio_enqueue_${regions.length - 1}`);
			enqueueFor.set(name, enqueue);
			m.addFunctionImport(
				enqueue,
				namespace,
				importName,
				binaryen.createType(encoded),
				binaryen.none
			);
		}
		const queued = new Set<string>();
		const labels = new Map<string, Map<string, string>>();
		for (const name of controllers) {
			const map = new Map<string, string>();
			const existing = new Set<string>();
			const visit = (e: number): void => {
				const v = info(e);
				if ((v.id === binaryen.BlockId || v.id === binaryen.LoopId) && v.name)
					existing.add(v.name);
				for (const child of children(v)) visit(child);
			};
			visit(functions.get(name)!.body);
			for (const label of existing) {
				let replacement = `${label}__folio`;
				while (existing.has(replacement) || [...map.values()].includes(replacement))
					replacement += '_';
				map.set(label, replacement);
			}
			labels.set(name, map);
		}
		let helperIndex = 0;
		const trappedUnary = new Set([
			binaryen.TruncSFloat32ToInt32,
			binaryen.TruncUFloat32ToInt32,
			binaryen.TruncSFloat64ToInt32,
			binaryen.TruncUFloat64ToInt32,
			binaryen.TruncSFloat32ToInt64,
			binaryen.TruncUFloat32ToInt64,
			binaryen.TruncSFloat64ToInt64,
			binaryen.TruncUFloat64ToInt64
		]);
		const trappedBinary = new Set([
			binaryen.DivSInt32,
			binaryen.DivUInt32,
			binaryen.RemSInt32,
			binaryen.RemUInt32,
			binaryen.DivSInt64,
			binaryen.DivUInt64,
			binaryen.RemSInt64,
			binaryen.RemUInt64
		]);
		const drain = () => m.call(barrier, [], binaryen.none);
		const helper = (
			expression: number,
			operands: number[],
			setters: string[],
			opaque = false
		) => {
			const v = info(expression);
			const resultType = v.id === binaryen.CallIndirectId ? v.results : v.type;
			const types = operands.map((e) => info(e).type);
			if (types.some((type) => !numeric.has(type)))
				throw new Error('non-scalar helper operand');
			const body =
				v.id === binaryen.CallIndirectId && v.isReturn
					? m.call_indirect(v.table, v.target, v.operands, v.params, v.results)
					: m.copyExpression(expression);
			for (let i = 0; i < setters.length; i++) {
				if (setters[i]!.startsWith('operand:')) {
					const index = Number(setters[i]!.slice(8));
					raw._BinaryenCallIndirectSetOperandAt(body, index, m.local.get(i, types[i]!));
				} else raw[setters[i]!](body, m.local.get(i, types[i]!));
			}
			const name = unique(`__folio_control_helper_${helperIndex++}`);
			let code: number;
			const vars: number[] = [];
			if (!opaque) code = m.block(null, [drain(), body], resultType);
			else {
				const prefix = [drain(), m.global.set(serial, m.i32.const(1))];
				if (resultType === binaryen.none || resultType === binaryen.unreachable)
					code = m.block(
						null,
						[...prefix, body, m.global.set(serial, m.i32.const(0))],
						resultType
					);
				else {
					vars.push(resultType);
					code = m.block(
						null,
						[
							...prefix,
							m.local.set(types.length, body),
							m.global.set(serial, m.i32.const(0)),
							m.local.get(types.length, resultType)
						],
						resultType
					);
				}
			}
			const result = resultType === binaryen.unreachable ? binaryen.none : resultType;
			m.addFunction(name, binaryen.createType(types), result, vars, code);
			return { name, result };
		};
		const lower = (expression: number, owner: string): number => {
			const v = info(expression);
			const label = (name: string) => labels.get(owner)!.get(name) ?? name;
			const callHelper = (operands: number[], setters: string[], opaque = false) => {
				const h = helper(expression, operands, setters, opaque);
				const values = operands.map((e) => lower(e, owner));
				return v.id === binaryen.CallIndirectId && v.isReturn
					? m.return_call(h.name, values, h.result)
					: m.call(h.name, values, h.result);
			};
			const enqueue = (call: Info) => {
				queued.add(owner);
				const values = call.operands.map((e: number) => {
					const value = lower(e, owner);
					const type = info(e).type;
					return type === binaryen.f32
						? m.i32.reinterpret(value)
						: type === binaryen.f64
							? m.i64.reinterpret(value)
							: value;
				});
				return m.call(enqueueFor.get(call.target)!, values, binaryen.none);
			};
			switch (v.id) {
				case binaryen.BlockId:
					return m.block(
						label(v.name),
						v.children.map((e: number) => lower(e, owner)),
						v.type
					);
				case binaryen.IfId:
					return m.if(
						lower(v.condition, owner),
						lower(v.ifTrue, owner),
						v.ifFalse ? lower(v.ifFalse, owner) : undefined
					);
				case binaryen.LoopId:
					return m.loop(
						label(v.name),
						m.block(
							null,
							[m.call(poll, [], binaryen.none), lower(v.body, owner)],
							info(v.body).type
						)
					);
				case binaryen.BreakId:
					return m.br(
						label(v.name),
						v.condition ? lower(v.condition, owner) : undefined,
						v.value ? lower(v.value, owner) : undefined
					);
				case binaryen.SwitchId:
					return m.switch(
						v.names.map(label),
						label(v.defaultName),
						lower(v.condition, owner),
						v.value ? lower(v.value, owner) : undefined
					);
				case binaryen.CallId: {
					if (!v.isReturn && v.type === binaryen.none && pure.has(v.target))
						return enqueue(v);
					const result = functions.get(v.target)!.results;
					const args = v.operands.map((e: number) => lower(e, owner));
					if (controllers.has(v.target))
						return v.isReturn
							? m.return_call(v.target, args, result)
							: m.call(v.target, args, result);
					const types = v.operands.map((e: number) => info(e).type);
					const target = unique(`__folio_control_host_${helperIndex++}`);
					const native = m.call(
						v.target,
						types.map((t: number, i: number) => m.local.get(i, t)),
						result
					);
					const prefix = [drain(), m.global.set(serial, m.i32.const(1))];
					const vars = result === binaryen.none ? [] : [result];
					const code = vars.length
						? m.block(
								null,
								[
									...prefix,
									m.local.set(types.length, native),
									m.global.set(serial, m.i32.const(0)),
									m.local.get(types.length, result)
								],
								result
							)
						: m.block(
								null,
								[...prefix, native, m.global.set(serial, m.i32.const(0))],
								result
							);
					m.addFunction(target, binaryen.createType(types), result, vars, code);
					return v.isReturn
						? m.return_call(target, args, result)
						: m.call(target, args, result);
				}
				case binaryen.CallIndirectId:
					return callHelper(
						[...v.operands, v.target],
						[
							...v.operands.map((_: number, i: number) => `operand:${i}`),
							'_BinaryenCallIndirectSetTarget'
						],
						true
					);
				case binaryen.LocalSetId:
					return v.isTee
						? m.local.tee(v.index, lower(v.value, owner), v.type)
						: m.local.set(v.index, lower(v.value, owner));
				case binaryen.LoadId:
					return callHelper([v.ptr], ['_BinaryenLoadSetPtr']);
				case binaryen.StoreId:
					return callHelper(
						[v.ptr, v.value],
						['_BinaryenStoreSetPtr', '_BinaryenStoreSetValue']
					);
				case binaryen.GlobalGetId:
				case binaryen.MemorySizeId:
				case binaryen.TableSizeId:
				case binaryen.DataDropId:
					return callHelper([], []);
				case binaryen.GlobalSetId:
					return callHelper([v.value], ['_BinaryenGlobalSetSetValue']);
				case binaryen.MemoryGrowId:
					return callHelper([v.delta], ['_BinaryenMemoryGrowSetDelta']);
				case binaryen.MemoryCopyId:
					return callHelper(
						[v.dest, v.source, v.size],
						[
							'_BinaryenMemoryCopySetDest',
							'_BinaryenMemoryCopySetSource',
							'_BinaryenMemoryCopySetSize'
						]
					);
				case binaryen.MemoryFillId:
					return callHelper(
						[v.dest, v.value, v.size],
						[
							'_BinaryenMemoryFillSetDest',
							'_BinaryenMemoryFillSetValue',
							'_BinaryenMemoryFillSetSize'
						]
					);
				case binaryen.MemoryInitId:
					return callHelper(
						[v.dest, v.offset, v.size],
						[
							'_BinaryenMemoryInitSetDest',
							'_BinaryenMemoryInitSetOffset',
							'_BinaryenMemoryInitSetSize'
						]
					);
				case binaryen.UnaryId:
					return trappedUnary.has(v.op)
						? callHelper([v.value], ['_BinaryenUnarySetValue'])
						: raw._BinaryenUnary(m.ptr, v.op, lower(v.value, owner));
				case binaryen.BinaryId:
					return trappedBinary.has(v.op)
						? callHelper(
								[v.left, v.right],
								['_BinaryenBinarySetLeft', '_BinaryenBinarySetRight']
							)
						: raw._BinaryenBinary(
								m.ptr,
								v.op,
								lower(v.left, owner),
								lower(v.right, owner)
							);
				case binaryen.SelectId:
					return m.select(
						lower(v.condition, owner),
						lower(v.ifTrue, owner),
						lower(v.ifFalse, owner)
					);
				case binaryen.DropId: {
					const child = info(v.value);
					return child.id === binaryen.CallId && !child.isReturn && pure.has(child.target)
						? enqueue(child)
						: m.drop(lower(v.value, owner));
				}
				case binaryen.ReturnId:
					return m.return(v.value ? lower(v.value, owner) : undefined);
				case binaryen.UnreachableId:
					return m.block(null, [drain(), m.unreachable()]);
				default:
					return m.copyExpression(expression);
			}
		};
		for (const name of controllers) {
			const f = functions.get(name)!;
			const transformed = m.block(
				null,
				[m.call(poll, [], binaryen.none), lower(f.body, name)],
				f.results
			);
			raw._BinaryenFunctionSetBody(
				m.getFunction(name),
				m.if(
					m.global.get(serial, binaryen.i32),
					m.copyExpression(originalBodies.get(name) ?? f.body),
					transformed
				)
			);
		}
		for (let changed = true; changed;) {
			changed = false;
			for (const name of controllers) {
				if (
					!queued.has(name) &&
					[...calls.get(name)!].some(
						(target) => controllers.has(target) && queued.has(target)
					)
				) {
					queued.add(name);
					changed = true;
				}
			}
		}
		const entries: string[] = [];
		for (let i = 0; i < m.getNumExports(); i++) {
			const exported = binaryen.getExportInfo(m.getExportByIndex(i));
			if (
				exported.kind === binaryen.ExternalFunction &&
				functions.has(exported.value) &&
				queued.has(exported.value)
			)
				entries.push(exported.name);
		}
		if (!entries.length) return;
		if (!m.validate() || !w.validate()) throw new Error('invalid control extraction');
		const coordinator = m.emitBinary();
		const workerOriginal = w.emitBinary();
		new WebAssembly.Module(Uint8Array.from(coordinator));
		new WebAssembly.Module(Uint8Array.from(workerOriginal));
		const transactional = prepareTracked(workerOriginal).transactional;
		if (!transactional) throw new Error('control worker transactional lowering unavailable');
		new WebAssembly.Module(Uint8Array.from(transactional));
		return {
			coordinator,
			workerOriginal,
			transactional,
			namespace,
			serialGlobal: 'serial',
			memoryExport,
			shared: memory.shared,
			initial: memory.initial,
			maximum,
			entries,
			regions,
			diagnostics
		};
	} finally {
		worker?.dispose();
		module?.dispose();
	}
}
