import binaryen from 'binaryen';
import { restoreImportOrder } from './import-order.ts';

/** Region admission. Both values are estimates in instruction units, not guarantees. */
export interface AdmissionOptions {
	/**
	 * Net work a region needs before dispatch, join and validation can pay for themselves; 0 admits
	 * every pure region. A loop bounded by a parameter is checked against the call's arguments.
	 */
	minimumRegionWork?: number;
	/** Iterations assumed for a loop whose bound is neither a constant nor a parameter. */
	assumedTripCount?: number;
}

/** Calibrated on Apple M2 Pro; see `results/execution/admission/admission-calibration.summary.json`. */
export const DEFAULT_MINIMUM_REGION_WORK = 200_000;
export const DEFAULT_ASSUMED_TRIP_COUNT = 1000;
// a tracked load or store costs about this many plain instructions in a speculative lane
const ACCESS_COST = 3600;
const CALL_COST = 2;
const SCALE_LIMIT = 2 ** 50;

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

export interface ControlPlan {
	coordinator: Uint8Array;
	workerOriginal: Uint8Array;
	transactional: Uint8Array;
	namespace: string;
	serialGlobal: string;
	pendingGlobal: string;
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

export interface Work {
	compute: number;
	accesses: number;
}

/** Work that grows with the product of the listed parameters, each bounding a loop. */
export interface Term extends Work {
	params: number[];
}

const comparisons = new Set([
	binaryen.LtUInt32,
	binaryen.LtSInt32,
	binaryen.LeUInt32,
	binaryen.LeSInt32,
	binaryen.GtUInt32,
	binaryen.GtSInt32,
	binaryen.GeUInt32,
	binaryen.GeSInt32,
	binaryen.NeInt32
]);

type Bound = { constant: number } | { parameter: number };

/** Which locals feed a loop bound untouched, and which are written and so can count. */
export interface LoopInputs {
	input(index: number): boolean;
	counter(index: number): boolean;
}

// a counted loop ends on a comparison of a counter local against a constant or an untouched input
function loopBound(loop: Info, inputs?: LoopInputs): Bound | undefined {
	const body = info(loop.body);
	const tail = body.id === binaryen.BlockId ? body.children.at(-1) : loop.body;
	if (tail === undefined) return;
	const branch = info(tail);
	if (branch.id !== binaryen.BreakId || branch.name !== loop.name || !branch.condition) return;
	const test = info(branch.condition);
	if (test.id !== binaryen.BinaryId || !comparisons.has(test.op)) return;
	const sides = [info(test.left), info(test.right)];
	for (const [index, bound] of sides.entries()) {
		if (bound.id === binaryen.ConstId && typeof bound.value === 'number' && bound.value >= 1)
			return { constant: bound.value };
		const counter = sides[1 - index]!;
		if (
			inputs &&
			bound.id === binaryen.LocalGetId &&
			inputs.input(bound.index) &&
			counter.id === binaryen.LocalGetId &&
			inputs.counter(counter.index)
		)
			return { parameter: bound.index };
	}
}

// a countdown loop ends on `local.tee $c (c - 1)`, so it runs for the value $c held on entry
function countdownLocal(loop: Info): number | undefined {
	const body = info(loop.body);
	const tail = body.id === binaryen.BlockId ? body.children.at(-1) : loop.body;
	if (tail === undefined) return;
	const branch = info(tail);
	if (branch.id !== binaryen.BreakId || branch.name !== loop.name || !branch.condition) return;
	const step = info(branch.condition);
	if (step.id !== binaryen.LocalSetId || !step.isTee) return;
	const next = info(step.value);
	if (next.id !== binaryen.BinaryId) return;
	const [from, by] = [info(next.left), info(next.right)];
	if (from.id !== binaryen.LocalGetId || from.index !== step.index || by.id !== binaryen.ConstId)
		return;
	const down =
		(next.op === binaryen.AddInt32 && by.value === -1) ||
		(next.op === binaryen.SubInt32 && by.value === 1);
	return down ? step.index : undefined;
}

/**
 * Trip-weighted instruction and tracked-access counts of one body, calls included. A loop bounded
 * by an untouched input makes a term in that local; other unknown bounds use `assumedTrips`.
 */
export function estimateTerms(
	body: number,
	callee: (name: string) => Work | undefined,
	assumedTrips: number,
	inputs?: LoopInputs
): Term[] {
	const terms = new Map<string, Term>();
	const add = (factor: number, params: number[], compute: number, accesses: number): void => {
		const key = params.join(',');
		const term = terms.get(key) ?? { params, compute: 0, accesses: 0 };
		term.compute = Math.min(term.compute + factor * compute, SCALE_LIMIT);
		term.accesses = Math.min(term.accesses + factor * accesses, SCALE_LIMIT);
		terms.set(key, term);
	};
	// what a local was last set to in program order: an untouched input or a constant
	const initial = new Map<number, Bound>();
	const visit = (expression: number, factor: number, params: number[]): void => {
		const v = info(expression);
		let inner = factor;
		let innerParams = params;
		let countdown: number | undefined;
		switch (v.id) {
			case binaryen.LocalSetId: {
				const value = info(v.value);
				if (value.id === binaryen.LocalGetId && inputs?.input(value.index))
					initial.set(v.index, { parameter: value.index });
				else if (
					value.id === binaryen.ConstId &&
					typeof value.value === 'number' &&
					value.value >= 1
				)
					initial.set(v.index, { constant: value.value });
				else initial.delete(v.index);
				add(factor, params, 1, 0);
				break;
			}
			case binaryen.LoopId: {
				countdown = countdownLocal(v);
				const bound =
					(countdown === undefined ? undefined : initial.get(countdown)) ??
					loopBound(v, inputs);
				if (bound && 'parameter' in bound)
					innerParams = [...params, bound.parameter].sort((a, b) => a - b);
				else
					inner = Math.min(
						factor * (bound && 'constant' in bound ? bound.constant : assumedTrips),
						SCALE_LIMIT
					);
				break;
			}
			case binaryen.CallId: {
				const known = callee(v.target);
				add(factor, params, CALL_COST + (known?.compute ?? 0), known?.accesses ?? 0);
				break;
			}
			case binaryen.LoadId:
			case binaryen.StoreId:
				add(factor, params, 1, 1);
				break;
			case binaryen.MemoryCopyId:
			case binaryen.MemoryFillId: {
				const size = info(v.size);
				add(
					factor,
					params,
					1,
					size.id === binaryen.ConstId ? Number(size.value) >>> 0 : assumedTrips
				);
				break;
			}
			case binaryen.BlockId:
			case binaryen.ConstId:
			case binaryen.LocalGetId:
			case binaryen.NopId:
			case binaryen.DropId:
				break;
			default:
				add(factor, params, 1, 0);
		}
		for (const child of children(v)) visit(child, inner, innerParams);
		if (countdown !== undefined) initial.delete(countdown);
	};
	visit(body, 1, []);
	return [...terms.values()];
}

function mergeTerms(lists: readonly (readonly Term[])[]): Term[] {
	const merged = new Map<string, Term>();
	for (const term of lists.flat()) {
		const key = term.params.join(',');
		const known = merged.get(key) ?? { params: term.params, compute: 0, accesses: 0 };
		known.compute += term.compute;
		known.accesses += term.accesses;
		merged.set(key, known);
	}
	return [...merged.values()];
}

/** Numeric work with every parameter-bounded loop assumed to run `assumedTrips` times. */
export function settleWork(terms: readonly Term[], assumedTrips: number): Work {
	const total: Work = { compute: 0, accesses: 0 };
	for (const term of terms) {
		const factor = Math.min(assumedTrips ** term.params.length, SCALE_LIMIT);
		total.compute = Math.min(total.compute + factor * term.compute, SCALE_LIMIT);
		total.accesses = Math.min(total.accesses + factor * term.accesses, SCALE_LIMIT);
	}
	return total;
}

export function estimateWork(
	body: number,
	callee: (name: string) => Work | undefined,
	assumedTrips: number
): Work {
	return settleWork(estimateTerms(body, callee, assumedTrips), assumedTrips);
}

export const netWork = (work: Work): number => work.compute - ACCESS_COST * work.accesses;

/**
 * `static` regions always run as regions, `dynamic` ones when their parameters make the estimate
 * reach the threshold at the call, and the rest never. A threshold of zero admits every region.
 */
function classify(terms: readonly Term[], minimum: number): 'static' | 'dynamic' | 'refused' {
	if (minimum === 0) return 'static';
	const fixed = terms.filter((term) => !term.params.length);
	if (fixed.reduce((sum, term) => sum + netWork(term), 0) >= minimum) return 'static';
	return terms.some((term) => term.params.length && netWork(term) > 0) ? 'dynamic' : 'refused';
}

/** Resolves defaults and rejects values the estimate cannot use. */
export function admission(options: AdmissionOptions) {
	const minimumWork = options.minimumRegionWork ?? DEFAULT_MINIMUM_REGION_WORK;
	const assumedTrips = options.assumedTripCount ?? DEFAULT_ASSUMED_TRIP_COUNT;
	if (!Number.isFinite(minimumWork) || minimumWork < 0)
		throw new RangeError('invalid minimumRegionWork');
	if (!Number.isInteger(assumedTrips) || assumedTrips < 1)
		throw new RangeError('invalid assumedTripCount');
	return { minimumWork, assumedTrips };
}

// every function on a call cycle, in discovery order
function recursiveFunctions(calls: Map<string, Set<string>>): Set<string> {
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
	return recursive;
}

// memoized per-function work; a call cycle is cut at its back edge, so the estimate of a recursive
// function counts one level of its own calls and always terminates
function workModel(
	functions: Map<string, FunctionInfo>,
	included: (name: string) => boolean,
	assumedTrips: number
) {
	const known = new Map<string, Term[]>();
	const termsOf = (name: string): Term[] => {
		let terms = known.get(name);
		if (!terms) {
			known.set(name, []);
			const f = functions.get(name)!;
			const written = new Set<number>();
			const scan = (e: number): void => {
				const v = info(e);
				if (v.id === binaryen.LocalSetId) written.add(v.index);
				for (const child of children(v)) scan(child);
			};
			scan(f.body);
			const count = binaryen.expandType(f.params).length;
			terms = estimateTerms(f.body, workOf, assumedTrips, {
				input: (index) => index < count && !written.has(index),
				counter: (index) => written.has(index)
			});
			known.set(name, terms);
		}
		return terms;
	};
	const workOf = (name: string): Work | undefined =>
		included(name) ? settleWork(termsOf(name), assumedTrips) : undefined;
	return { termsOf, workOf };
}

// a run of statements with the locals and effects the outliner needs to know about
interface Span {
	expression: number;
	reads: Map<number, number>;
	writes: Set<number>;
	locals: Set<number>;
	memoryWrite: boolean;
	compute: boolean;
}

// what a span may contain beyond the pure nodes: calls into a known set, reads of named globals
interface SpanAllowance {
	call?: (target: string) => boolean;
	global?: (name: string) => boolean;
}

// a span with every reason it cannot move into another function; none means it can
function summarizeSpan(
	expression: number,
	allow: SpanAllowance = {}
): { span: Span; refusals: Set<string> } {
	const span: Span = {
		expression,
		reads: new Map(),
		writes: new Set(),
		locals: new Set(),
		memoryWrite: false,
		compute: false
	};
	const refusals = new Set<string>();
	const labels = new Set<string>();
	const targets: string[] = [];
	if (info(expression).type !== binaryen.none) refusals.add('statement has a value');
	const visit = (e: number): void => {
		const v = info(e);
		if (v.id === binaryen.CallId) {
			if (!allow.call?.(v.target)) refusals.add('call outside the worker set');
		} else if (v.id === binaryen.GlobalGetId) {
			if (!allow.global?.(v.name)) refusals.add('global access');
		} else if (v.id === binaryen.CallIndirectId) refusals.add('indirect call');
		else if (v.id === binaryen.ReturnId) refusals.add('return in the body');
		else if (!pureNodes.has(v.id)) refusals.add('impure expression');
		if (v.isAtomic) refusals.add('atomic access');
		if (![binaryen.none, binaryen.unreachable].includes(v.type) && !numeric.has(v.type))
			refusals.add('non-numeric value');
		if ((v.id === binaryen.BlockId || v.id === binaryen.LoopId) && v.name) labels.add(v.name);
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
		if ([binaryen.StoreId, binaryen.MemoryCopyId, binaryen.MemoryFillId].includes(v.id))
			span.memoryWrite = true;
		if ([binaryen.LoopId, binaryen.IfId, binaryen.BinaryId, binaryen.UnaryId].includes(v.id))
			span.compute = true;
		for (const child of children(v)) visit(child);
	};
	visit(expression);
	if (!targets.every((target) => labels.has(target))) refusals.add('branch escapes the body');
	return { span, refusals };
}

// locals the spans write that something else reads, or that they read before assigning
function carriedLocals(spans: Span[], totalReads: Map<number, number>): Set<number> {
	const reads = new Map<number, number>();
	const writes = new Set<number>();
	for (const span of spans) {
		for (const [index, amount] of span.reads)
			reads.set(index, (reads.get(index) ?? 0) + amount);
		for (const index of span.writes) writes.add(index);
	}
	const carried = new Set(
		[...writes].filter((index) => (totalReads.get(index) ?? 0) !== (reads.get(index) ?? 0))
	);
	const exits = new Map<string, Set<number>[]>();
	const intersect = (paths: Set<number>[]): Set<number> | undefined =>
		paths.length
			? new Set([...paths[0]!].filter((index) => paths.every((path) => path.has(index))))
			: undefined;
	const flow = (expression: number, incoming: Set<number>): Set<number> | undefined => {
		const v = info(expression);
		let assigned: Set<number> | undefined = new Set(incoming);
		if (v.id === binaryen.LocalGetId && writes.has(v.index) && !assigned.has(v.index))
			carried.add(v.index);
		if (v.id === binaryen.IfId) {
			assigned = flow(v.condition, assigned);
			if (!assigned) return;
			return intersect(
				[flow(v.ifTrue, assigned), v.ifFalse ? flow(v.ifFalse, assigned) : assigned].filter(
					(path): path is Set<number> => path !== undefined
				)
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
			const targets = v.id === binaryen.SwitchId ? [...v.names, v.defaultName] : [v.name];
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
	return carried;
}

// renumbers the locals of an expression in place
function remapLocals(expression: number, positions: Map<number, number>): void {
	const v = info(expression);
	if (v.id === binaryen.LocalGetId)
		raw._BinaryenLocalGetSetIndex(expression, positions.get(v.index)!);
	if (v.id === binaryen.LocalSetId)
		raw._BinaryenLocalSetSetIndex(expression, positions.get(v.index)!);
	for (const child of children(v)) remapLocals(child, positions);
}

export function extract(
	original: Uint8Array,
	prepareTracked: (bytes: Uint8Array) => { transactional?: Uint8Array },
	options: AdmissionOptions & {
		refused?: (reason: string) => void;
		/** called once per candidate span or pure function with its estimate and verdict */
		observed?: (site: {
			name: string;
			kind: string;
			compute: number;
			accesses: number;
		}) => void;
	} = {}
): ControlPlan | undefined {
	const { minimumWork, assumedTrips } = admission(options);
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
			const summarize = (expression: number): Span | undefined => {
				const summary = summarizeSpan(expression);
				return summary.refusals.size ? undefined : summary.span;
			};
			const outline = (spans: Span[]): number[] => {
				const carried = carriedLocals(spans, totalReads);
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
				const written = new Set(spans.flatMap((span) => [...span.writes]));
				const spanned = mergeTerms(
					spans.map((span) =>
						estimateTerms(span.expression, () => undefined, assumedTrips, {
							input: (index) => !written.has(index),
							counter: (index) => written.has(index)
						})
					)
				);
				const verdict = classify(spanned, minimumWork);
				if (options.observed) {
					const work = settleWork(spanned, assumedTrips);
					options.observed({ name: `span in ${f.name}`, kind: verdict, ...work });
				}
				if (verdict === 'refused') return spans.map((span) => span.expression);
				const captured = [...new Set(spans.flatMap((span) => [...span.locals]))].sort(
					(a, b) => a - b
				);
				const positions = new Map(captured.map((index, position) => [index, position]));
				const body = m.block(
					null,
					spans.map((span) => m.copyExpression(span.expression))
				);
				remapLocals(body, positions);
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
		for (const name of recursiveFunctions(calls)) {
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
		if (!pure.size) {
			options.refused?.('no pure function to run as a region');
			return;
		}
		const { termsOf } = workModel(functions, (name) => pure.has(name), assumedTrips);
		const admitted = new Set<string>();
		const guarded = new Map<string, Term[]>();
		for (const name of pure) {
			const kind = classify(termsOf(name), minimumWork);
			options.observed?.({
				name,
				kind,
				...settleWork(termsOf(name), assumedTrips)
			});
			if (kind !== 'refused') admitted.add(name);
			if (kind === 'dynamic') guarded.set(name, termsOf(name));
		}
		const enqueued = new Set<string>();
		const queued = new Set<string>();
		const enqueues = (v: Info): string | undefined => {
			const call = v.id === binaryen.DropId ? info(v.value) : v;
			const direct = v.id === binaryen.CallId && v.type === binaryen.none;
			if (
				call.id === binaryen.CallId &&
				!call.isReturn &&
				(direct || v.id === binaryen.DropId) &&
				admitted.has(call.target)
			)
				return call.target;
		};
		for (const name of controllers) {
			const visit = (e: number): void => {
				const v = info(e);
				const target = enqueues(v);
				if (target) {
					enqueued.add(target);
					queued.add(name);
				}
				for (const child of children(v)) visit(child);
			};
			visit(functions.get(name)!.body);
		}
		if (!enqueued.size) {
			options.refused?.(
				admitted.size
					? `no admitted region has a call site (${pure.size} pure functions, ${admitted.size} admitted)`
					: `no region reached ${minimumWork} net work (${pure.size} pure functions, none admitted)`
			);
			return;
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
		// a function that never reaches a region keeps its original body and runs natively
		for (const name of [...controllers]) if (!queued.has(name)) controllers.delete(name);
		for (const f of originals) {
			if (f.body && !controllers.has(f.name))
				raw._BinaryenFunctionSetBody(m.getFunction(f.name), originalBodies.get(f.name)!);
		}
		diagnostics.push(
			`region admission: ${enqueued.size} regions from ${admitted.size} of ${pure.size} pure functions at ${minimumWork} net work; ${queued.size} instrumented`
		);
		let namespace = '__folio_control';
		const imported = WebAssembly.Module.imports(
			new WebAssembly.Module(Uint8Array.from(original))
		);
		while (imported.some((item) => item.module === namespace)) namespace += '_';
		let serial = '__folio_control_serial';
		while (m.getGlobal(serial)) serial += '_';
		let pending = '__folio_control_pending';
		while (m.getGlobal(pending)) pending += '_';
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
		m.addGlobalImport(pending, namespace, 'pending', binaryen.i32, true);
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
		for (const name of enqueued) {
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
		const memoryHelpers = new Map<string, { name: string; result: number }>();
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
		// the host raises `pending` while regions are queued; an empty queue never crosses into JSPI
		const whenPending = (target: string) =>
			m.if(m.global.get(pending, binaryen.i32), m.call(target, [], binaryen.none));
		const drain = () => whenPending(barrier);
		const joinPoll = () => whenPending(poll);
		// a call the owner makes natively: queued regions join first, and callees see serial set
		const hostCalls = new Map<string, string>();
		const hostCall = (target: string): string => {
			const known = hostCalls.get(target);
			if (known) return known;
			const callee = functions.get(target)!;
			const types = binaryen.expandType(callee.params);
			const result = callee.results;
			const name = unique(`__folio_control_host_${helperIndex++}`);
			const native = m.call(
				target,
				types.map((t, i) => m.local.get(i, t)),
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
				: m.block(null, [...prefix, native, m.global.set(serial, m.i32.const(0))], result);
			m.addFunction(name, binaryen.createType(types), result, vars, code);
			hostCalls.set(target, name);
			return name;
		};
		// a region with a parameter-bounded loop compares its estimate with the threshold per call
		const routes = new Map<string, { callee: string; encoded: boolean }>();
		for (const name of enqueued) {
			const entry = enqueueFor.get(name)!;
			const terms = guarded.get(name);
			if (!terms) {
				routes.set(name, { callee: entry, encoded: true });
				continue;
			}
			const f = functions.get(name)!;
			const params = binaryen.expandType(f.params);
			const local = (i: number) => m.local.get(i, params[i]!);
			let work = m.f64.const(0);
			for (const term of terms) {
				if (!netWork(term)) continue;
				let product = m.f64.const(netWork(term));
				for (const parameter of term.params)
					product = m.f64.mul(product, m.f64.convert_u.i32(local(parameter)));
				work = m.f64.add(work, product);
			}
			const queue = m.call(
				entry,
				params.map((t, i) =>
					t === binaryen.f32
						? m.i32.reinterpret(local(i))
						: t === binaryen.f64
							? m.i64.reinterpret(local(i))
							: local(i)
				),
				binaryen.none
			);
			const native = m.call(
				hostCall(name),
				params.map((_, i) => local(i)),
				f.results
			);
			const dispatch = unique(`__folio_dispatch_${routes.size}`);
			m.addFunction(
				dispatch,
				binaryen.createType(params),
				binaryen.none,
				[],
				m.if(
					m.f64.ge(work, m.f64.const(minimumWork)),
					queue,
					f.results === binaryen.none ? native : m.drop(native)
				)
			);
			routes.set(name, { callee: dispatch, encoded: false });
		}
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
			// One memory is admitted. Retain every opcode attribute; only operands become parameters.
			const memoryKey =
				v.id === binaryen.LoadId || v.id === binaryen.StoreId
					? JSON.stringify([
							types,
							Object.entries(v).filter(([key]) => key !== 'ptr' && key !== 'value')
						])
					: undefined;
			if (memoryKey !== undefined) {
				const existing = memoryHelpers.get(memoryKey);
				if (existing) return existing;
			}
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
			const reference = { name, result };
			if (memoryKey !== undefined) memoryHelpers.set(memoryKey, reference);
			return reference;
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
				const route = routes.get(call.target)!;
				const values = call.operands.map((e: number) => {
					const value = lower(e, owner);
					const type = info(e).type;
					return !route.encoded
						? value
						: type === binaryen.f32
							? m.i32.reinterpret(value)
							: type === binaryen.f64
								? m.i64.reinterpret(value)
								: value;
				});
				return m.call(route.callee, values, binaryen.none);
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
						m.block(null, [joinPoll(), lower(v.body, owner)], info(v.body).type)
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
					if (!v.isReturn && v.type === binaryen.none && enqueueFor.has(v.target))
						return enqueue(v);
					const result = functions.get(v.target)!.results;
					const args = v.operands.map((e: number) => lower(e, owner));
					if (controllers.has(v.target))
						return v.isReturn
							? m.return_call(v.target, args, result)
							: m.call(v.target, args, result);
					const target = hostCall(v.target);
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
					return child.id === binaryen.CallId &&
						!child.isReturn &&
						enqueueFor.has(child.target)
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
			const transformed = m.block(null, [joinPoll(), lower(f.body, name)], f.results);
			raw._BinaryenFunctionSetBody(
				m.getFunction(name),
				m.if(
					m.global.get(serial, binaryen.i32),
					m.copyExpression(originalBodies.get(name) ?? f.body),
					transformed
				)
			);
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
		if (!entries.length) {
			options.refused?.('no exported function reaches an admitted region');
			return;
		}
		if (!m.validate() || !w.validate()) throw new Error('invalid control extraction');
		const coordinator = restoreImportOrder(
			m.emitBinary(),
			WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(original)))
		);
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
			pendingGlobal: 'pending',
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

/**
 * The stack route: functions a worker could run when it holds a private copy of one mutable i32
 * global, the stack pointer, and calls may recurse. Nothing consumes it yet, and it never changes
 * the control plan or the module-wide reasons.
 */
export interface StackRoute {
	/** True when at least one function can run on a worker and no global is refused for the module. */
	eligible: boolean;
	/** The one admitted mutable global and its initial value, when a function reads it. */
	stack?: { name: string; initial: number };
	/** Immutable globals with a constant initializer that the set reads. */
	constants: string[];
	/** The worker set: closed under calls, in module order. */
	functions: string[];
	/** The members that sit on a call cycle. */
	recursive: string[];
	/** Static work per member; a recursive member counts one level of its own calls. */
	work: Record<string, Work>;
	/** Why the module is or is not eligible. */
	diagnostics: string[];
}

/** Computes the stack route of a module. A failure is reported in `diagnostics`, never thrown. */
export function stackRoute(original: Uint8Array, options: AdmissionOptions = {}): StackRoute {
	const { assumedTrips } = admission(options);
	const route: StackRoute = {
		eligible: false,
		constants: [],
		functions: [],
		recursive: [],
		work: Object.create(null),
		diagnostics: []
	};
	let module: binaryen.Module | undefined;
	try {
		if (memoryCount(original) !== 1) {
			route.diagnostics.push('exactly one memory required');
			return route;
		}
		module = binaryen.readBinary(original);
		if (module.getMemoryInfo().is64) {
			route.diagnostics.push('wasm64 memory');
			return route;
		}
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		module.setFeatures(binaryen.Features.All & ~compactImports);
		const globals = new Map<
			string,
			{ mutable: boolean; refusal?: string; initial?: number; constant: boolean }
		>();
		for (let i = 0; i < module.getNumGlobals(); i++) {
			const g = binaryen.getGlobalInfo(module.getGlobalByIndex(i));
			const init = g.module ? undefined : info(g.init);
			const constant = init?.id === binaryen.ConstId;
			globals.set(g.name, {
				mutable: g.mutable,
				constant,
				initial: constant && g.type === binaryen.i32 ? Number(init!.value) : undefined,
				refusal: g.module
					? 'imported global'
					: !numeric.has(g.type)
						? 'reference-typed global'
						: !constant
							? 'initializer is not a constant'
							: g.mutable && g.type !== binaryen.i32
								? 'mutable global is not i32'
								: undefined
			});
		}
		type Body = {
			info: FunctionInfo;
			cause?: string;
			targets: Set<string>;
			refs: Set<string>;
		};
		const bodies: Body[] = [];
		for (let i = 0; i < module.getNumFunctions(); i++) {
			const f = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
			if (!f.body) continue;
			const body: Body = { info: f, targets: new Set(), refs: new Set() };
			if (
				![...binaryen.expandType(f.params), ...f.vars].every((t) => numeric.has(t)) ||
				!(f.results === binaryen.none || numeric.has(f.results))
			)
				body.cause = 'non-numeric signature';
			const visit = (expression: number): void => {
				const v = info(expression);
				if (!supported.has(v.id)) body.cause ??= 'unsupported expression';
				else if (v.id === binaryen.GlobalGetId || v.id === binaryen.GlobalSetId)
					body.refs.add(v.name);
				else if (!pureNodes.has(v.id)) body.cause ??= 'impure expression';
				if (v.isAtomic) body.cause ??= 'atomic access';
				if (![binaryen.none, binaryen.unreachable].includes(v.type) && !numeric.has(v.type))
					body.cause ??= 'non-numeric value';
				if (v.id === binaryen.CallId) body.targets.add(v.target);
				for (const child of children(v)) visit(child);
			};
			try {
				visit(f.body);
			} catch {
				body.cause ??= 'unreadable expression';
			}
			bodies.push(body);
		}
		const referenced = new Set(bodies.flatMap((body) => [...body.refs]));
		const named = [...globals.keys()].filter((name) => referenced.has(name));
		const mutable = named.filter((name) => globals.get(name)!.mutable);
		if (mutable.length > 1) {
			for (const name of mutable.slice(1))
				route.diagnostics.push(
					`refused global ${name}: second mutable global (stack candidate ${mutable[0]})`
				);
			return route;
		}
		const refused = new Set<string>();
		for (const name of named) {
			const g = globals.get(name)!;
			if (g.refusal) {
				refused.add(name);
				route.diagnostics.push(`refused global ${name}: ${g.refusal}`);
			} else if (g.mutable) route.stack = { name, initial: g.initial! };
			else route.constants.push(name);
		}
		if (route.stack) route.diagnostics.push(`stack global ${route.stack.name}`);
		for (const body of bodies)
			if (!body.cause && [...body.refs].some((name) => refused.has(name)))
				body.cause = 'refused global';
		const members = new Set(bodies.filter((body) => !body.cause).map((b) => b.info.name));
		for (let changed = true; changed;) {
			changed = false;
			for (const body of bodies) {
				if (body.cause || ![...body.targets].some((name) => !members.has(name))) continue;
				body.cause = 'call outside the set';
				members.delete(body.info.name);
				changed = true;
			}
		}
		const inSet = bodies.filter((body) => members.has(body.info.name));
		route.functions = inSet.map((body) => body.info.name);
		const cyclic = recursiveFunctions(new Map(inSet.map((b) => [b.info.name, b.targets])));
		route.recursive = route.functions.filter((name) => cyclic.has(name));
		const model = workModel(
			new Map(inSet.map((body) => [body.info.name, body.info])),
			(name) => members.has(name),
			assumedTrips
		);
		for (const name of route.functions) route.work[name] = model.workOf(name)!;
		route.diagnostics.push(
			`worker set: ${route.functions.length} of ${bodies.length} functions, ${route.recursive.length} recursive`
		);
		const causes = new Map<string, number>();
		for (const body of bodies)
			if (body.cause) causes.set(body.cause, (causes.get(body.cause) ?? 0) + 1);
		if (causes.size)
			route.diagnostics.push(
				`excluded: ${[...causes]
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.map(([cause, count]) => `${count} ${cause}`)
					.join(', ')}`
			);
		route.eligible = route.functions.length > 0;
		if (!route.eligible) route.diagnostics.push('no function can run on a worker');
		return route;
	} catch (error) {
		return {
			eligible: false,
			constants: [],
			functions: [],
			recursive: [],
			work: Object.create(null),
			diagnostics: [
				`stack route unavailable: ${error instanceof Error ? error.message : String(error)}`
			]
		};
	} finally {
		module?.dispose();
	}
}

/** One local of the owner that the schedule or the outlined body needs. */
export interface IterationLocal {
	local: number;
	/** `induction` is the trip counter; `stride` advances by a constant each iteration */
	kind: 'induction' | 'stride' | 'invariant' | 'frame';
	/** position in the `iterate` argument list; absent when the body never reads the local */
	argument?: number;
	/** where the value at loop entry comes from, when it is an owner parameter or a constant */
	start?: { parameter: number } | { constant: number };
	/** change per iteration, modulo 2^32; the value for iteration k is `start + k * stride` */
	stride?: number;
	/**
	 * a stride held in an owner local the loop never writes: the step is `stride * entry[strideLocal]`
	 * with `stride` 1 or -1, read at loop entry, and the value for iteration k is `start + k * step`
	 */
	strideLocal?: number;
}

/**
 * The iteration route: one owner function whose single loop runs independent calls into the worker
 * set. It reads the stack route and changes nothing; `Folio.open` consumes it when no older route
 * covers the program. `module` holds the worker set, the stack global and the constants, with
 * `iterate` doing one iteration of the body.
 *
 * The route proves a shape, not independence. A loop-carried dependence through the owner frame
 * is caught at run time: the lowered worker module tracks the frame bytes each iteration reads
 * before it writes them, and validation fails an iteration that read a byte an earlier iteration
 * of its batch wrote. Reads of stale callee stack below the frame and imported host functions that
 * touch memory are not tracked.
 */
export interface IterationRoute {
	eligible: boolean;
	owner?: string;
	/** the loop label, when the owner names it */
	loop?: string;
	/** the loop runs the entry value of `local` times; an entry value of zero runs it 2^32 times */
	trip?: { local: number; parameter?: number; constant?: number };
	/** every local the body reads or the schedule advances; `iterate` takes them in `argument` order */
	locals: IterationLocal[];
	/**
	 * the owner's frame: `local` holds `global - size` after the prologue and `iterate` takes it last.
	 * The image at [global - size, global) is copied into each slot at enqueue; a body that reads a
	 * frame byte an earlier iteration wrote is not detected here.
	 */
	frame?: { global: string; size: number; local: number; copy: true };
	/** export names in `module` */
	iterate?: string;
	stackExport?: string;
	module?: Uint8Array;
	diagnostics: string[];
}

const emptyIteration = (diagnostics: string[]): IterationRoute => ({
	eligible: false,
	locals: [],
	diagnostics
});

/**
 * Finds an owner whose single loop is a countdown over independent calls into the stack route's
 * worker set and outlines one iteration of it. A refusal is a named diagnostic, never an exception.
 */
export function iterationRoute(original: Uint8Array, route: StackRoute): IterationRoute {
	if (!route.eligible)
		return emptyIteration([
			`stack route refused: ${route.diagnostics.join('; ') || 'empty set'}`
		]);
	let module: binaryen.Module | undefined;
	try {
		module = binaryen.readBinary(original);
		const m = module;
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		m.setFeatures(binaryen.Features.All & ~compactImports);
		const members = new Set(route.functions);
		const stack = route.stack?.name;
		const constants = new Set(route.constants);
		const refusals: string[] = [];
		for (let i = 0; i < m.getNumFunctions(); i++) {
			const f = binaryen.getFunctionInfo(m.getFunctionByIndex(i));
			if (!f.body || !callsInLoop(f.body, members)) continue;
			const plan = outlineOwner(m, f, { members, stack, constants, route });
			if (plan.route) {
				plan.route.diagnostics.unshift(...refusals);
				return plan.route;
			}
			for (const reason of plan.refusals)
				if (refusals.length < 16) refusals.push(`refused loop in ${f.name}: ${reason}`);
		}
		refusals.push('no loop calls into the worker set');
		return emptyIteration(refusals);
	} catch (error) {
		return emptyIteration([
			`iteration route unavailable: ${error instanceof Error ? error.message : String(error)}`
		]);
	} finally {
		module?.dispose();
	}
}

// does any loop in the body contain a call to a member of the set
function callsInLoop(body: number, members: Set<string>): boolean {
	const visit = (expression: number, inLoop: boolean): boolean => {
		const v = info(expression);
		if (inLoop && v.id === binaryen.CallId && members.has(v.target)) return true;
		return children(v).some((child) => visit(child, inLoop || v.id === binaryen.LoopId));
	};
	try {
		return visit(body, false);
	} catch {
		return false;
	}
}

interface StrideUpdate {
	local: number;
	/** the constant change per iteration, or 1 or -1 when `strideLocal` holds the step */
	stride: number;
	strideLocal?: number;
}

// `local = local + c`, `local - c`, `local + other` or `local - other` as a statement
function strideUpdate(statement: number): StrideUpdate | undefined {
	const set = info(statement);
	if (set.id !== binaryen.LocalSetId || set.isTee) return;
	const next = info(set.value);
	if (next.id !== binaryen.BinaryId) return;
	const [left, right] = [info(next.left), info(next.right)];
	const isSelf = (v: Info) => v.id === binaryen.LocalGetId && v.index === set.index;
	const constant = (v: Info) =>
		v.id === binaryen.ConstId && typeof v.value === 'number' ? v : undefined;
	const other = (v: Info) =>
		v.id === binaryen.LocalGetId && v.index !== set.index ? v.index : undefined;
	if (next.op === binaryen.AddInt32) {
		if (isSelf(left) && constant(right)) return { local: set.index, stride: right.value | 0 };
		if (isSelf(right) && constant(left)) return { local: set.index, stride: left.value | 0 };
		if (isSelf(left) && other(right) !== undefined)
			return { local: set.index, stride: 1, strideLocal: other(right) };
		if (isSelf(right) && other(left) !== undefined)
			return { local: set.index, stride: 1, strideLocal: other(left) };
	}
	if (next.op === binaryen.SubInt32 && isSelf(left)) {
		if (constant(right)) return { local: set.index, stride: -right.value | 0 };
		if (other(right) !== undefined)
			return { local: set.index, stride: -1, strideLocal: other(right) };
	}
}

function outlineOwner(
	m: binaryen.Module,
	f: FunctionInfo,
	context: {
		members: Set<string>;
		stack: string | undefined;
		constants: Set<string>;
		route: StackRoute;
	}
): { route?: IterationRoute; refusals: string[] } {
	const { members, stack, constants } = context;
	const refuse = new Set<string>();
	const localTypes = [...binaryen.expandType(f.params), ...f.vars];
	const parameterCount = binaryen.expandType(f.params).length;
	if (!localTypes.every((type) => numeric.has(type)))
		return { refusals: ['non-numeric signature'] };

	// one pass: loops, write and read counts, the loop's own writes
	const loops: number[] = [];
	const writes = new Map<number, number>();
	const totalReads = new Map<number, number>();
	const scan = (expression: number): void => {
		const v = info(expression);
		if (v.id === binaryen.LoopId) loops.push(expression);
		if (v.id === binaryen.LocalSetId) writes.set(v.index, (writes.get(v.index) ?? 0) + 1);
		if (v.id === binaryen.LocalGetId)
			totalReads.set(v.index, (totalReads.get(v.index) ?? 0) + 1);
		for (const child of children(v)) scan(child);
	};
	scan(f.body);
	if (loops.length !== 1) return { refusals: [`${loops.length} loops, one required`] };
	const loopExpression = loops[0]!;
	const loop = info(loopExpression);

	// the blocks that lead to the loop, outermost first
	const levels: { children: number[]; index: number }[] = [];
	const locate = (expression: number): boolean => {
		if (expression === loopExpression) return true;
		const v = info(expression);
		if (v.id !== binaryen.BlockId) return false;
		for (let i = 0; i < v.children.length; i++) {
			if (!locate(v.children[i])) continue;
			levels.unshift({ children: v.children, index: i });
			return true;
		}
		return false;
	};
	if (!locate(f.body)) return { refusals: ['the loop is not reached through blocks'] };
	const before = levels.flatMap((level) => level.children.slice(0, level.index));
	const after = levels.flatMap((level) => level.children.slice(level.index + 1));

	// the trip count: a countdown that ends on its own decrement
	const counter = countdownLocal(loop);
	if (counter === undefined || localTypes[counter] !== binaryen.i32)
		return { refusals: ['trip count is not computable before the loop starts'] };
	const loopWrites = new Map<number, number>();
	const countLoopWrites = (expression: number): void => {
		const v = info(expression);
		if (v.id === binaryen.LocalSetId)
			loopWrites.set(v.index, (loopWrites.get(v.index) ?? 0) + 1);
		for (const child of children(v)) countLoopWrites(child);
	};
	countLoopWrites(loopExpression);
	if ((loopWrites.get(counter) ?? 0) !== 1)
		return { refusals: ['trip count is not computable before the loop starts'] };

	// the loop body, the trailing stride updates and the back edge; a step is a constant or an i32
	// local the loop never writes
	const body = info(loop.body);
	const statements: number[] = body.id === binaryen.BlockId ? body.children : [loop.body];
	const stepIsInvariant = (update: StrideUpdate) =>
		update.strideLocal === undefined ||
		(localTypes[update.strideLocal] === binaryen.i32 && !loopWrites.get(update.strideLocal));
	const updates = new Map<number, StrideUpdate>([[counter, { local: counter, stride: -1 }]]);
	let end = statements.length - 1;
	while (end > 0) {
		const update = strideUpdate(statements[end - 1]!);
		if (
			!update ||
			updates.has(update.local) ||
			localTypes[update.local] !== binaryen.i32 ||
			loopWrites.get(update.local) !== 1 ||
			!stepIsInvariant(update)
		)
			break;
		updates.set(update.local, update);
		end--;
	}

	// top-level updates that stay in the body: iterate runs them, so later statements see the new
	// value; a stride-shaped statement that cannot stay names why, used if its local is carried
	const midUpdates = new Map<number, StrideUpdate>();
	const shaped = new Map<number, string>();
	const scanUpdates = (expression: number, top: boolean, conditional: boolean): void => {
		const v = info(expression);
		const update = v.id === binaryen.LocalSetId ? strideUpdate(expression) : undefined;
		if (update && update.local !== counter && localTypes[update.local] === binaryen.i32) {
			if (!top)
				shaped.set(
					update.local,
					conditional
						? 'stride update is conditional'
						: 'stride update is not at the top level of the body'
				);
			else if (loopWrites.get(update.local) !== 1)
				shaped.set(update.local, 'stride update of a local the loop also writes elsewhere');
			else if (!stepIsInvariant(update))
				shaped.set(update.local, 'stride is written in the loop');
			else midUpdates.set(update.local, update);
		}
		for (const child of children(v))
			scanUpdates(child, false, conditional || v.id === binaryen.IfId);
	};
	for (const statement of statements.slice(0, end)) scanUpdates(statement, true, false);
	for (const [local, update] of midUpdates) updates.set(local, update);
	const spans: Span[] = [];
	for (const statement of statements.slice(0, end)) {
		const summary = summarizeSpan(statement, {
			call: (target) => members.has(target),
			global: (name) => name === stack || constants.has(name)
		});
		for (const reason of summary.refusals) refuse.add(reason);
		spans.push(summary.span);
	}
	if (!spans.length) refuse.add('empty loop body');

	// the frame: `sp = global - size` in the owner's prologue
	let frame: IterationRoute['frame'];
	if (stack) {
		const frameOf = (expression: number) => {
			const sub = info(expression);
			if (sub.id !== binaryen.BinaryId || sub.op !== binaryen.SubInt32) return;
			const [from, size] = [info(sub.left), info(sub.right)];
			if (
				from.id === binaryen.GlobalGetId &&
				from.name === stack &&
				size.id === binaryen.ConstId
			)
				return size.value as number;
		};
		const top = levels[0] ? levels[0].children.slice(0, levels[0].index) : [];
		for (const [i, statement] of top.entries()) {
			const v = info(statement);
			if (v.id === binaryen.GlobalSetId && v.name === stack) {
				const tee = info(v.value);
				const size =
					tee.id === binaryen.LocalSetId && tee.isTee ? frameOf(tee.value) : undefined;
				if (size !== undefined)
					frame = { global: stack, size, local: tee.index, copy: true };
			}
			if (v.id === binaryen.LocalSetId && !v.isTee && frameOf(v.value) !== undefined) {
				const next = top[i + 1] ? info(top[i + 1]!) : undefined;
				const value = next?.id === binaryen.GlobalSetId ? info(next.value) : undefined;
				if (
					next?.name === stack &&
					value?.id === binaryen.LocalGetId &&
					value.index === v.index
				)
					frame = { global: stack, size: frameOf(v.value)!, local: v.index, copy: true };
			}
			if (frame) break;
		}
		if (frame && (writes.get(frame.local) ?? 0) !== 1) frame = undefined;
	}

	// locals that hold or derive from a frame address
	const tainted = new Set<number>(frame ? [frame.local] : []);
	const derives = (expression: number): boolean => {
		const v = info(expression);
		if (v.id === binaryen.LocalGetId && tainted.has(v.index)) return true;
		if (v.id === binaryen.GlobalGetId && v.name === stack) return true;
		return children(v).some(derives);
	};
	for (let changed = true; changed;) {
		changed = false;
		const grow = (expression: number): void => {
			const v = info(expression);
			if (v.id === binaryen.LocalSetId && !tainted.has(v.index) && derives(v.value)) {
				tainted.add(v.index);
				changed = true;
			}
			for (const child of children(v)) grow(child);
		};
		grow(f.body);
	}

	const callsMember = (expression: number): boolean => {
		const v = info(expression);
		return (v.id === binaryen.CallId && members.has(v.target)) || children(v).some(callsMember);
	};
	if (spans.length && !spans.some((span) => callsMember(span.expression)))
		refuse.add('no call into the worker set in the loop body');
	for (const span of spans) {
		const check = (expression: number): void => {
			const v = info(expression);
			if (v.id === binaryen.StoreId && derives(v.value))
				refuse.add('frame address stored to memory');
			if (
				(v.id === binaryen.CallIndirectId ||
					(v.id === binaryen.CallId && !members.has(v.target))) &&
				children(v).some(derives)
			)
				refuse.add('frame address passed outside the worker set');
			if (v.id === binaryen.GlobalGetId && v.name === stack && !frame)
				refuse.add('stack global read in the body without a frame');
			for (const child of children(v)) check(child);
		};
		check(span.expression);
	}

	// what runs after the loop must not read the frame; the epilogue restore is the one allowed use
	const afterReads = new Map<number, number>();
	const inspect = (expression: number): void => {
		const v = info(expression);
		if (frame && v.id === binaryen.GlobalSetId && v.name === stack) {
			const sum = info(v.value);
			const [a, b] = sum.id === binaryen.BinaryId ? [info(sum.left), info(sum.right)] : [];
			if (
				sum.op === binaryen.AddInt32 &&
				a?.id === binaryen.LocalGetId &&
				a.index === frame.local &&
				b?.id === binaryen.ConstId &&
				b.value === frame.size
			)
				return;
		}
		if (v.id === binaryen.LocalGetId) {
			afterReads.set(v.index, (afterReads.get(v.index) ?? 0) + 1);
			if (tainted.has(v.index)) refuse.add('frame object read after the loop');
		}
		for (const child of children(v)) inspect(child);
	};
	for (const statement of after) inspect(statement);

	const bodyWrites = new Set(spans.flatMap((span) => [...span.writes]));
	const carried = carriedLocals(spans, totalReads);
	for (const local of bodyWrites) {
		if (midUpdates.has(local)) continue;
		if (afterReads.get(local))
			refuse.add('loop body writes a local the code after the loop reads');
		else if (carried.has(local)) {
			refuse.add('carried local is not a constant stride');
			const why = shaped.get(local);
			if (why) refuse.add(why);
		}
	}
	// the owner sets a constant-stride local to its loop-exit value, and has no way to do that for a
	// step that is held in a local
	for (const [local, update] of updates)
		if (update.strideLocal !== undefined && afterReads.get(local))
			refuse.add('local advanced by a run-time stride is read after the loop');

	// classify what the body reads
	const bodyReads = new Set(spans.flatMap((span) => [...span.reads.keys()]));
	const entry = (local: number): IterationLocal['start'] => {
		const outside = (writes.get(local) ?? 0) - (loopWrites.get(local) ?? 0);
		if (local < parameterCount && outside === 0) return { parameter: local };
		if (outside !== 1) return;
		for (const statement of [...before].reverse()) {
			const v = info(statement);
			if (v.id !== binaryen.LocalSetId || v.isTee || v.index !== local) continue;
			const value = info(v.value);
			if (value.id === binaryen.ConstId && typeof value.value === 'number')
				return { constant: value.value >>> 0 };
			if (
				value.id === binaryen.LocalGetId &&
				value.index < parameterCount &&
				!writes.get(value.index)
			)
				return { parameter: value.index };
			return;
		}
	};
	const strided: IterationLocal[] = [];
	const invariant: IterationLocal[] = [];
	for (const [local, update] of [...updates].sort(([a], [b]) => a - b))
		strided.push({
			local,
			kind: local === counter ? 'induction' : 'stride',
			start: entry(local),
			stride: update.stride,
			...(update.strideLocal === undefined ? {} : { strideLocal: update.strideLocal })
		});
	for (const local of [...bodyReads].sort((a, b) => a - b)) {
		if (bodyWrites.has(local) || updates.has(local) || local === frame?.local) continue;
		if ((loopWrites.get(local) ?? 0) > 0) refuse.add('carried local is not a constant stride');
		invariant.push({ local, kind: 'invariant', start: entry(local) });
	}
	// a step local the body does not read still needs its loop-entry value, so `iterate` takes it too
	const steps = new Set(
		[...updates.values()].flatMap((update) =>
			update.strideLocal === undefined ? [] : [update.strideLocal]
		)
	);
	for (const local of [...steps].sort((a, b) => a - b))
		if (!invariant.some((item) => item.local === local))
			invariant.push({ local, kind: 'invariant', start: entry(local) });
	invariant.sort((a, b) => a.local - b.local);
	for (const item of [...strided, ...invariant]) {
		if (bodyReads.has(item.local) && tainted.has(item.local))
			refuse.add('frame address held in a local the body reads');
		if (steps.has(item.local) && tainted.has(item.local))
			refuse.add('frame address used as a run-time stride');
	}
	if (refuse.size) return { refusals: [...refuse] };

	// `iterate`: strided and invariant locals in order, then the frame base, then the body's temporaries
	const parameters = [...strided, ...invariant].filter(
		(item) => bodyReads.has(item.local) || steps.has(item.local)
	);
	const order = [...parameters.map((item) => item.local), ...(frame ? [frame.local] : [])];
	const temporaries = [...new Set(spans.flatMap((span) => [...span.locals]))]
		.filter((local) => !order.includes(local))
		.sort((a, b) => a - b);
	const positions = new Map([...order, ...temporaries].map((local, index) => [local, index]));
	parameters.forEach((item, index) => (item.argument = index));

	const memory = m.getMemoryInfo();
	const internalMemory = memoryName(m);
	const w = new binaryen.Module();
	try {
		w.setFeatures(m.getFeatures() | binaryen.Features.Atomics);
		w.setMemory(memory.initial, memory.max ?? 65536, null, [], true, false, internalMemory);
		w.addMemoryImport(internalMemory, 'env', 'memory', true);
		if (stack)
			w.addGlobal(stack, binaryen.i32, true, w.i32.const(context.route.stack!.initial));
		for (const name of constants) {
			const g = binaryen.getGlobalInfo(m.getGlobal(name));
			w.addGlobal(name, g.type, false, w.copyExpression(g.init));
		}
		for (const name of context.route.functions) {
			const g = binaryen.getFunctionInfo(m.getFunction(name));
			w.addFunction(name, g.params, g.results, g.vars, w.copyExpression(g.body));
		}
		let iterate = '__folio_iterate';
		while (w.getFunction(iterate)) iterate += '_';
		const block = w.block(
			null,
			spans.map((span) => w.copyExpression(span.expression))
		);
		remapLocals(block, positions);
		w.addFunction(
			iterate,
			binaryen.createType(order.map((local) => localTypes[local]!)),
			binaryen.none,
			temporaries.map((local) => localTypes[local]!),
			block
		);
		w.addFunctionExport(iterate, iterate);
		const stackExport = '__folio_stack';
		if (stack) w.addGlobalExport(stack, stackExport);
		if (!w.validate()) throw new Error('invalid iteration module');
		const bytes = w.emitBinary();
		new WebAssembly.Module(Uint8Array.from(bytes));
		const trip = entry(counter);
		const locals: IterationLocal[] = [
			...strided,
			...invariant,
			...(frame
				? [{ local: frame.local, kind: 'frame' as const, argument: order.length - 1 }]
				: [])
		];
		const diagnostics = [
			`owner ${f.name}: countdown loop on local ${counter}, ${spans.length} body statements, ${order.length} arguments`
		];
		if (frame)
			diagnostics.push(`frame ${frame.global} - ${frame.size} in local ${frame.local}`);
		return {
			refusals: [],
			route: {
				eligible: true,
				owner: f.name,
				loop: loop.name || undefined,
				trip: { local: counter, ...(trip ?? {}) },
				locals,
				frame,
				iterate,
				stackExport: stack ? stackExport : undefined,
				module: bytes,
				diagnostics
			}
		};
	} finally {
		w.dispose();
	}
}
