import { binaryen, children } from './elastic-walk.ts';

export interface StackCheckOptions {
	/** lowest stack pointer the stack may reach; read from `emscripten_stack_init` when omitted */
	limit?: number;
	/** false rewrites the module without adding a check, as the control arm of a timing pair */
	insert?: boolean;
	/** add a new local at every check; the first build of the pass did this and its module is the g4 arm */
	freshLocal?: boolean;
}

export interface StackCheckStats {
	limit: number;
	functions: number;
	writers: number;
	sites: Record<'lowerConst' | 'lowerVar' | 'local' | 'raise', number>;
	checks: number;
	locals: number;
	/** functions with two or more checks */
	multi: number;
	bytesIn: number;
	bytesOut: number;
}

export class StackCheckRefusal extends Error {
	reasons: string[];
	constructor(reasons: string[]) {
		super(`folio.stackCheck refuses this module: ${reasons.join('; ')}`);
		this.name = 'StackCheckRefusal';
		this.reasons = reasons;
	}
}

const i32 = binaryen.i32;

/**
 * Inserts `if (sp <u limit) unreachable` between the computation of a lowered stack pointer and the
 * `global.set` that publishes it, so a frame never reaches the static data under the stack. A raise by a
 * constant is not checked. A stack pointer write in any other shape refuses the module.
 */
export function stackCheck(input: Uint8Array, options: StackCheckOptions = {}) {
	const mod = binaryen.readBinary(input);
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
		return run(mod, input.length, options);
	} finally {
		mod.dispose();
	}
}

function exportedFunction(mod: any, name: string): number | undefined {
	for (let k = 0; k < mod.getNumExports(); k++) {
		const ex = binaryen.getExportInfo(mod.getExportByIndex(k));
		if (ex.name === name && ex.kind === binaryen.ExternalFunction)
			return mod.getFunction(ex.value);
	}
	return undefined;
}

// the stack end the module itself stores: get_end returns a global that emscripten_stack_init sets to a constant
function moduleLimit(mod: any, unknown: Set<string>): number | undefined {
	const getEnd = exportedFunction(mod, 'emscripten_stack_get_end');
	const init = exportedFunction(mod, 'emscripten_stack_init');
	if (!getEnd || !init) return undefined;
	const read = binaryen.Function.getBody(getEnd);
	if (binaryen.getExpressionId(read) !== binaryen.GlobalGetId) return undefined;
	const endName = binaryen.GlobalGet.getName(read);
	let found: number | undefined;
	const scan = (e: number) => {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.GlobalSetId && binaryen.GlobalSet.getName(e) === endName) {
			const v = binaryen.GlobalSet.getValue(e);
			if (binaryen.getExpressionId(v) === binaryen.ConstId)
				found = binaryen.Const.getValueI32(v) >>> 0;
		}
		children(e, id, (c) => scan(c), unknown);
	};
	scan(binaryen.Function.getBody(init));
	return found;
}

function run(mod: any, bytesIn: number, options: StackCheckOptions) {
	const unknown = new Set<string>();
	const reasons: string[] = [];
	if (mod.getNumGlobals() === 0) throw new StackCheckRefusal(['no stack pointer global']);
	const spName = binaryen.getGlobalInfo(mod.getGlobalByIndex(0)).name;
	const fromModule = moduleLimit(mod, unknown);
	if (options.limit !== undefined && fromModule !== undefined && options.limit !== fromModule)
		throw new StackCheckRefusal([
			`limit ${options.limit} differs from the module stack end ${fromModule}`
		]);
	const limit = options.limit ?? fromModule;
	if (limit === undefined)
		throw new StackCheckRefusal(['no stack end in the module and no limit option']);
	const insert = options.insert ?? true;

	const exportNames = new Map<string, string>();
	for (let k = 0; k < mod.getNumExports(); k++) {
		const ex = binaryen.getExportInfo(mod.getExportByIndex(k));
		if (ex.kind === binaryen.ExternalFunction && !exportNames.has(ex.value))
			exportNames.set(ex.value, ex.name);
	}

	const stats: StackCheckStats = {
		limit,
		functions: 0,
		writers: 0,
		sites: { lowerConst: 0, lowerVar: 0, local: 0, raise: 0 },
		checks: 0,
		locals: 0,
		multi: 0,
		bytesIn,
		bytesOut: 0
	};
	const constOf = (e: number): number | undefined =>
		binaryen.getExpressionId(e) === binaryen.ConstId && binaryen.getExpressionType(e) === i32
			? binaryen.Const.getValueI32(e)
			: undefined;
	// the expression under any local.tee wrappers
	const core = (e: number): number => {
		while (binaryen.getExpressionId(e) === binaryen.LocalSetId)
			e = binaryen.LocalSet.getValue(e);
		return e;
	};

	const numFunctions = mod.getNumFunctions();
	for (let index = 0; index < numFunctions; index++) {
		const fn = mod.getFunctionByIndex(index);
		const body = binaryen.Function.getBody(fn);
		if (!body) continue;
		stats.functions++;
		const fname = binaryen.Function.getName(fn);
		const label = `function ${index} (${exportNames.get(fname) ?? fname})`;
		let wrote = false;
		let fnChecks = 0;

		const site = (e: number, set: (x: number) => void) => {
			wrote = true;
			const value = binaryen.GlobalSet.getValue(e);
			const v = core(value);
			const vid = binaryen.getExpressionId(v);
			let kind: 'lowerConst' | 'lowerVar' | 'local' | 'raise' | undefined;
			// the subtraction whose left operand is captured for the wrap around test, set when the frame can wrap
			let sub: number | undefined;
			if (vid === binaryen.LocalGetId) kind = 'local';
			else if (vid === binaryen.BinaryId) {
				const op = binaryen.Binary.getOp(v);
				const left = binaryen.Binary.getLeft(v);
				const right = binaryen.Binary.getRight(v);
				const rc = constOf(right);
				if (op === binaryen.SubInt32) {
					if (rc !== undefined) {
						kind = rc > 0 ? 'lowerConst' : 'raise';
						if (rc >= limit) sub = v;
					} else {
						kind = 'lowerVar';
						sub = v;
					}
				} else if (op === binaryen.AddInt32) {
					if (rc !== undefined) {
						kind = rc < 0 ? 'lowerConst' : 'raise';
						if (-rc >= limit) sub = v;
					} else reasons.push(`${label}: add of two non-constants`);
				} else if (op === binaryen.AndInt32 && constOf(right) !== undefined) {
					const inner = core(left);
					if (
						binaryen.getExpressionId(inner) === binaryen.BinaryId &&
						binaryen.Binary.getOp(inner) === binaryen.SubInt32 &&
						constOf(binaryen.Binary.getRight(inner)) === undefined
					) {
						kind = 'lowerVar';
						sub = inner;
					} else reasons.push(`${label}: and of an expression that is not an alloca`);
				} else reasons.push(`${label}: binary operation ${op} as the new stack pointer`);
			} else if (vid === binaryen.ConstId) reasons.push(`${label}: constant stack pointer`);
			else if (vid === binaryen.CallId) reasons.push(`${label}: stack pointer from a call`);
			else reasons.push(`${label}: expression kind ${vid} as the new stack pointer`);
			if (!kind) return;
			stats.sites[kind]++;
			if (kind === 'raise' || !insert) return;
			stats.checks++;
			fnChecks++;
			// a prologue that already tees the new pointer into a local keeps that local, so no frame slot is added
			const tee =
				!options.freshLocal &&
				binaryen.getExpressionId(value) === binaryen.LocalSetId &&
				binaryen.getExpressionType(value) === i32;
			let t: number;
			let computed = value;
			if (tee) {
				t = binaryen.LocalSet.getIndex(value);
				computed = binaryen.LocalSet.getValue(value);
			} else {
				t = binaryen._BinaryenFunctionAddVar(fn, i32);
				stats.locals++;
			}
			const get = (k: number) => mod.local.get(k, i32);
			let bad = mod.i32.lt_u(get(t), mod.i32.const(limit | 0));
			if (sub !== undefined) {
				const tl = binaryen._BinaryenFunctionAddVar(fn, i32);
				stats.locals++;
				binaryen.Binary.setLeft(sub, mod.local.tee(tl, binaryen.Binary.getLeft(sub), i32));
				bad = mod.i32.or(bad, mod.i32.gt_u(get(t), get(tl)));
			}
			binaryen.GlobalSet.setValue(e, get(t));
			set(mod.block(null, [mod.local.set(t, computed), mod.if(bad, mod.unreachable()), e]));
		};

		const rewrite = (e: number, set: (x: number) => void) => {
			const id = binaryen.getExpressionId(e);
			children(e, id, (c, s) => rewrite(c, s), unknown);
			if (id === binaryen.GlobalSetId && binaryen.GlobalSet.getName(e) === spName)
				site(e, set);
		};
		rewrite(body, (x) => binaryen.Function.setBody(fn, x));
		if (wrote) stats.writers++;
		if (fnChecks > 1) stats.multi++;
	}
	if (unknown.size) reasons.push(...[...unknown].sort().map((u) => `unwalked expression: ${u}`));
	if (reasons.length) throw new StackCheckRefusal(reasons);
	if (!mod.validate()) throw new TypeError('folio.stackCheck produced an invalid module');
	const bytes = mod.emitBinary();
	stats.bytesOut = bytes.length;
	return { bytes, stats };
}
