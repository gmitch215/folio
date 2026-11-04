import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { predictEnd, probeAffine, type AffineModel } from '../../../src/affine.ts';
import { checkLoop } from '../loop-check.ts';
import { checkStream } from '../stream-check.ts';

// shared harness: build, run both spike checkers, run ground truth, classify

export interface Entry {
	id: string;
	group: string;
	note: string;
	source: string; // WAT text, C text or opcode bytes
	bytes: Uint8Array;
}

const OFFSET = 1048576;
const MAXLEN = 262144;
const input = Uint8Array.from(
	{ length: MAXLEN + 64 },
	(_, k) => (Math.imul(k, 2654435761) ^ (k >>> 8)) & 255
);
const LENS = [0, 1, 7, 64, 1000, 4096, 65537, 100000, MAXLEN];
const STATES = [0, 1, 0x80000000, 0xffffffff];
const MODEL_LENS = [0, 1, 2, 31, 257, 65537, MAXLEN];

/** Takes the output directory from the command line and creates its `build` folder. */
export function outputDirectory(): string {
	const dir = process.argv[2];
	if (!dir) throw new Error('usage: OUTPUT_DIRECTORY');
	mkdirSync(`${dir}/build`, { recursive: true });
	return dir;
}

export const moduleName = (id: string) => id.replace(/\//g, '-');
export const moduleBytes = (dir: string, id: string) =>
	new Uint8Array(readFileSync(`${dir}/build/${moduleName(id)}.wasm`));

export const buildWat = (
	text: string,
	memory = '(memory (export "memory") 32 512)'
): Uint8Array => {
	const module = binaryen.parseText(`(module ${memory} ${text})`);
	try {
		module.setFeatures(binaryen.Features.All & ~(binaryen.Features as any).CompactImports);
		if (!module.validate()) throw new Error('binaryen validation failed');
		const bytes = Uint8Array.from(module.emitBinary());
		new WebAssembly.Module(bytes);
		return bytes;
	} finally {
		module.dispose();
	}
};

const importsFor = (mod: WebAssembly.Module) => {
	const out: WebAssembly.Imports = {};
	for (const i of WebAssembly.Module.imports(mod)) {
		out[i.module] ??= {};
		out[i.module]![i.name] =
			i.kind === 'function'
				? () => 0
				: i.kind === 'memory'
					? new WebAssembly.Memory({ initial: 32, maximum: 512 })
					: i.kind === 'global'
						? new WebAssembly.Global({ value: 'i32', mutable: false }, 0)
						: new WebAssembly.Table({ element: 'anyfunc', initial: 4 });
	}
	return out;
};

const fresh = (mod: WebAssembly.Module, entry: string) => {
	const instance = new WebAssembly.Instance(mod, importsFor(mod));
	const memory = instance.exports.memory as WebAssembly.Memory;
	if (memory.buffer.byteLength < OFFSET + MAXLEN + 64) memory.grow(32);
	new Uint8Array(memory.buffer, OFFSET, input.length).set(input);
	const fn = instance.exports[entry] as Function;
	return (state: number, at: number, len: number): number | string => {
		try {
			return (fn(state | 0, OFFSET + at, len) as number) >>> 0;
		} catch (e) {
			return 'trap';
		}
	};
};

export interface Truth {
	composes: boolean;
	firstFailure: string;
	error?: string;
}

export function truth(bytes: Uint8Array, entry = 'update'): Truth {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	try {
		for (const length of LENS) {
			for (const state of STATES) {
				const whole = fresh(mod, entry)(state, 0, length);
				for (const cut of [Math.floor(length / 3), Math.floor(length / 2), length - 1]) {
					if (cut < 0 || cut > length) continue;
					const call = fresh(mod, entry);
					const first = call(state, 0, cut);
					const chain =
						typeof first === 'string' ? first : call(first, cut, length - cut);
					if (chain !== whole)
						return {
							composes: false,
							firstFailure: `length ${length} cut ${cut} state ${state >>> 0} whole ${whole} chain ${chain}`
						};
				}
			}
		}
		return { composes: true, firstFailure: '' };
	} catch (e) {
		return { composes: false, firstFailure: 'harness error', error: String(e) };
	}
}

// the same bytes at another address must give the same result (alignment and address independence)
export function relocation(bytes: Uint8Array, entry = 'update'): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	for (const length of [1, 7, 1000, 65537]) {
		for (const state of [1, 0xffffffff]) {
			const base = fresh(mod, entry)(state, 0, length);
			for (const shift of [1, 3, 4096, 12345]) {
				const instance = new WebAssembly.Instance(mod, importsFor(mod));
				const memory = instance.exports.memory as WebAssembly.Memory;
				if (memory.buffer.byteLength < OFFSET + MAXLEN + 64) memory.grow(32);
				const at = OFFSET + 400000 + shift;
				new Uint8Array(memory.buffer, at, length).set(input.subarray(0, length));
				let moved: number | string;
				try {
					moved =
						((instance.exports[entry] as Function)(state | 0, at, length) as number) >>>
						0;
				} catch {
					moved = 'trap';
				}
				if (moved !== base)
					return `length ${length} state ${state >>> 0} shift ${shift} base ${base} moved ${moved}`;
			}
		}
	}
	return '';
}

// the model claim: operator plus a zero-start chunk run reproduces the serial result
export function modelGrid(bytes: Uint8Array, model: AffineModel, entry = 'update'): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	for (const length of MODEL_LENS) {
		for (const initial of STATES) {
			const serial = fresh(mod, entry)(initial, 0, length);
			for (const width of [1, 2, 4, 8]) {
				let combined = BigInt(initial >>> 0);
				for (let k = 0; k < width; k++) {
					const from = Math.floor((k * length) / width);
					const to = Math.floor(((k + 1) * length) / width);
					const chunk = fresh(mod, entry)(0, from, to - from);
					if (typeof chunk === 'string' || typeof serial === 'string') {
						if (chunk === serial) continue;
						return `trap mismatch length ${length}`;
					}
					combined = predictEnd(model, combined, to - from, BigInt(chunk));
				}
				if (typeof serial === 'string') continue;
				if (combined !== BigInt(serial))
					return `length ${length} state ${initial >>> 0} width ${width} predicted ${combined} serial ${serial}`;
			}
		}
	}
	return '';
}

// operator columns A e_k = T(e_k, x) ^ T(0, x) for one byte, to build a model without the checkers
export function ownModel(bytes: Uint8Array, entry = 'update'): AffineModel | undefined {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const call = fresh(mod, entry);
	let operator: bigint[] | undefined;
	// the operator must not depend on the byte or its position
	for (const at of [1, 2, 3, 5, 8, 13, 255, 4097]) {
		const base = call(0, at, 1);
		if (typeof base === 'string') return undefined;
		const columns: bigint[] = [];
		for (let k = 0; k < 32; k++) {
			const r = call(2 ** k, at, 1);
			if (typeof r === 'string') return undefined;
			columns.push(BigInt((r ^ base) >>> 0));
		}
		if (operator && operator.some((v, k) => v !== columns[k])) return undefined;
		operator = columns;
	}
	if (!operator) return undefined;
	return {
		kind: 'model',
		ring: 'gf2',
		bits: 32,
		align: 1,
		layout: { entry, state: 0, ptr: 1, len: 2, bits: 32 },
		operator,
		calls: 0,
		checks: []
	};
}

const first = (e: unknown) =>
	String((e as Error)?.message ?? e)
		.split('\n')[0]!
		.slice(0, 100);

export interface Verdict {
	accepted: boolean;
	reason: string;
	model?: AffineModel;
}

export const runStream = (bytes: Uint8Array): Verdict => {
	try {
		const r = checkStream(bytes);
		return { accepted: true, reason: '', model: r.model };
	} catch (e) {
		return { accepted: false, reason: first(e) };
	}
};

export const runLoop = (bytes: Uint8Array): Verdict => {
	try {
		const r = checkLoop(bytes, 'update');
		return { accepted: true, reason: '', model: r.model };
	} catch (e) {
		return { accepted: false, reason: first(e) };
	}
};

export interface Row {
	id: string;
	group: string;
	note: string;
	source: string;
	moduleSha256?: string;
	stream: { accepted: boolean; reason: string; modelFailure?: string };
	loop: { accepted: boolean; reason: string; modelFailure?: string };
	truth: Truth;
	probe: string; // gf2 | z2w | refusal reason
	validAffine: 'gf2' | 'z2w' | 'no';
	relocation?: string;
	class: Record<string, string>;
}

export function evaluate(entry: Entry): Row {
	const stream = runStream(entry.bytes);
	const loop = runLoop(entry.bytes);
	const t = truth(entry.bytes);
	const row: Row = {
		id: entry.id,
		group: entry.group,
		note: entry.note,
		source: entry.source,
		moduleSha256: createHash('sha256').update(entry.bytes).digest('hex'),
		stream: { accepted: stream.accepted, reason: stream.reason },
		loop: { accepted: loop.accepted, reason: loop.reason },
		truth: t,
		probe: '',
		validAffine: 'no',
		class: {}
	};
	for (const [name, v, slot] of [
		['stream', stream, row.stream],
		['loop', loop, row.loop]
	] as const) {
		if (v.accepted) {
			const failure = modelGrid(entry.bytes, v.model!);
			(slot as { modelFailure?: string }).modelFailure = failure;
			row.class[name] = t.composes && !failure ? 'accepted-correct' : 'ACCEPTED-WRONG';
		}
	}
	if (stream.accepted || loop.accepted) row.relocation = relocation(entry.bytes);
	// independent view of validity: operator sampled from 1-byte calls, then the exact grid
	if (t.composes) {
		try {
			const own = ownModel(entry.bytes);
			if (own && !modelGrid(entry.bytes, own)) {
				row.validAffine = 'gf2';
				row.probe = 'own-operator gf2';
			}
		} catch (e) {
			row.probe = `own error: ${first(e)}`;
		}
	}
	if (t.composes && row.validAffine === 'no') {
		try {
			const probe = probeAffine(entry.bytes, 'update');
			if (probe.kind === 'model') {
				row.probe = probe.ring;
				const fail = modelGrid(entry.bytes, probe);
				if (!fail) row.validAffine = probe.ring;
			} else row.probe = `refused: ${probe.reason}`.slice(0, 80);
		} catch (e) {
			row.probe = `probe error: ${first(e)}`;
		}
	}
	for (const [name, v] of [
		['stream', stream],
		['loop', loop]
	] as const) {
		if (!v.accepted)
			row.class[name] =
				row.validAffine === 'gf2'
					? 'FALSE-REFUSAL'
					: row.validAffine === 'z2w'
						? 'refused-z2w-out-of-class'
						: 'correct-refusal';
	}
	return row;
}

/** Evaluates every entry, writes `rows-NAME.json` and each module under `DIR/build`. */
export function runBatch(entries: Entry[], dir: string, name: string) {
	const out = `${dir}/rows-${name}.json`;
	if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
	const rows: Row[] = [];
	for (const e of entries) {
		const file = `${dir}/build/${moduleName(e.id)}.wasm`;
		if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
		writeFileSync(file, e.bytes);
		try {
			rows.push(evaluate(e));
		} catch (err) {
			rows.push({
				id: e.id,
				group: e.group,
				note: e.note,
				source: e.source,
				moduleSha256: createHash('sha256').update(e.bytes).digest('hex'),
				stream: { accepted: false, reason: 'harness' },
				loop: { accepted: false, reason: 'harness' },
				truth: { composes: false, firstFailure: 'harness error ' + first(err) },
				probe: '',
				validAffine: 'no',
				class: { stream: 'harness-error', loop: 'harness-error' }
			});
		}
	}
	writeFileSync(out, JSON.stringify(rows, null, 1), { flag: 'wx' });
	const tally: Record<string, number> = {};
	for (const r of rows)
		for (const k of ['stream', 'loop'] as const) {
			const key = `${k}:${r.class[k] ?? 'n/a'}`;
			tally[key] = (tally[key] ?? 0) + 1;
		}
	console.log(rows.length, 'modules', JSON.stringify(tally));
	for (const r of rows)
		if (Object.values(r.class).includes('ACCEPTED-WRONG'))
			console.log('WRONG', r.id, r.stream, r.loop, r.truth);
}
