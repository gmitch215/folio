import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
	buildAdversarial,
	buildMiniz,
	buildSubjects,
	subjects
} from '../../scripts/research/affine-build.ts';
import {
	buildAdversarialContext,
	buildContextSubjects,
	buildCorpusContextSubjects,
	corpusContext,
	corpusEntry,
	ownContext
} from '../../scripts/research/affine-state-build.ts';
import { checkLoop, Refusal, refusalOf } from '../../scripts/research/loop-check.ts';
import { caseWat } from '../../scripts/research/redteam/gen-ops.ts';
import { buildWat } from '../../scripts/research/redteam/lib.ts';
import { build, mutants } from '../../scripts/research/split-sensitivity.ts';
import { checkStream } from '../../scripts/research/stream-check.ts';
import {
	foldState,
	modelSubject,
	pick,
	predictState,
	probeState,
	stateSerial,
	type ContextSubject,
	type StateModel
} from '../../src/affine-state.ts';
import {
	advance,
	foldAffine,
	predictEnd,
	probeAffine,
	type AffineLayout,
	type AffineModel
} from '../../src/affine.ts';
import { TaskPool } from '../../src/tasks.ts';

const worker = new URL('../../scripts/research/affine-worker.ts', import.meta.url);
const open: { pool: TaskPool; workers: Worker[] }[] = [];

interface Session {
	model: AffineModel;
	pool: TaskPool;
	serial: (input: Uint8Array, state?: bigint) => bigint;
}

function start(wasm: string, layout: AffineLayout, count: number): TaskPool {
	const pool = new TaskPool(count);
	const workers: Worker[] = [];
	for (let index = 0; index < count; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(worker, { workerData: { link, wasm, layout }, transferList: [link.port] })
		);
	}
	open.push({ pool, workers });
	return pool;
}

// the whole input in one call on a private instance, the serial reference
function direct(wasm: string, layout: AffineLayout) {
	const { memory, [layout.entry]: fn } = new WebAssembly.Instance(
		new WebAssembly.Module(readFileSync(wasm)),
		{}
	).exports as { memory: WebAssembly.Memory; [name: string]: unknown };
	const call = fn as (...args: (number | bigint)[]) => number | bigint;
	return (input: Uint8Array, state = 0n) => {
		const need = (1 << 20) + input.length;
		if (memory.buffer.byteLength < need) memory.grow(Math.ceil(need / 65536));
		new Uint8Array(memory.buffer, 1 << 20, input.length).set(input);
		const args: (number | bigint)[] = [0, 0, 0];
		args[layout.state] = layout.bits === 32 ? Number(BigInt.asIntN(32, state)) : state;
		args[layout.ptr] = 1 << 20;
		args[layout.len] = input.length;
		return BigInt.asUintN(layout.bits, BigInt(call(...args)));
	};
}

let seed = 0x2545f491;
const next = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return seed >>> 0;
};
function random(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) out[i] = next() & 255;
	return out;
}

const dir = new URL('../../build/research/affine/', import.meta.url).pathname;
const minizPath = () =>
	existsSync(`${dir}miniz-crc32.wasm`) ? `${dir}miniz-crc32.wasm` : undefined;
const sessions = new Map<string, Session>();
const positive = ['crc32c', 'crc16', 'crc64', 'poly31', 'lcg'];
let paths: Record<string, string>;
let miniz: string | undefined;

beforeAll(() => {
	paths = buildSubjects();
	miniz = buildMiniz() ?? minizPath();
}, 60000);

afterAll(async () => {
	for (const { pool, workers } of open.splice(0)) {
		pool.close();
		await Promise.all(workers.map((w) => w.terminate()));
	}
});

function session(name: string, wasm: string, entry: string, width = 4): Session {
	let found = sessions.get(name);
	if (!found) {
		const model = probeAffine(readFileSync(wasm), entry);
		assert.equal(model.kind, 'model', name);
		found = {
			model,
			pool: start(wasm, model.layout, width),
			serial: direct(wasm, model.layout)
		};
		sessions.set(name, found);
	}
	return found;
}

describe('discovery', () => {
	for (const spec of subjects) {
		test(`${spec.name}: ${spec.ring === 'none' ? 'refused' : spec.ring}`, () => {
			const result = probeAffine(readFileSync(paths[spec.name]!), spec.entry, {
				align: spec.align
			});
			if (spec.ring === 'none') {
				assert.equal(result.kind, 'refusal');
				assert.ok(result.checks.some((c) => !c.passed));
				assert.ok(result.checks.every((c) => c.name === 'additivity of the state part'));
				assert.ok(result.calls > 0);
				return;
			}
			assert.equal(result.kind, 'model');
			if (result.kind !== 'model') return;
			assert.equal(result.ring, spec.ring);
			assert.equal(result.bits, spec.name === 'crc64' ? 64 : 32);
			assert.ok(result.checks.filter((c) => c.ring === spec.ring).every((c) => c.passed));
			assert.ok(result.calls > result.bits);
		});
	}

	test('the same seed gives the same model and call count', () => {
		const bytes = readFileSync(paths.crc32c!);
		const a = probeAffine(bytes, 'crc32c', { seed: 7 });
		const b = probeAffine(bytes, 'crc32c', { seed: 7 });
		assert.deepEqual(a, b);
	});

	test('a module without the entry throws', () => {
		const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
		assert.throws(() => probeAffine(empty, 'nothing'));
	});

	test('the miniz mz_crc32 export is probed as it is built, and matches zlib', () => {
		if (!miniz) return;
		const model = probeAffine(readFileSync(miniz), 'mz_crc32');
		assert.equal(model.kind, 'model');
		if (model.kind !== 'model') return;
		assert.equal(model.ring, 'gf2');
		const input = random(5000);
		const serial = direct(miniz, model.layout);
		assert.equal(serial(input), BigInt(crc32(input) >>> 0));
	});
});

describe('operators', () => {
	test('the squared operator equals the brute force run on small lengths', () => {
		for (const name of ['crc32c', 'crc64', 'poly31']) {
			const spec = subjects.find((s) => s.name === name)!;
			const model = probeAffine(readFileSync(paths[name]!), spec.entry);
			assert.equal(model.kind, 'model');
			if (model.kind !== 'model') continue;
			const run = direct(paths[name]!, model.layout);
			for (const length of [0, 1, 2, 3, 5, 8, 17, 64, 100, 513, 4096]) {
				const x = random(length);
				const s = (BigInt(next()) << 32n) | BigInt(next());
				const start = BigInt.asUintN(model.bits, s);
				const offset = run(x, 0n);
				assert.equal(
					advance(model, start, length),
					model.ring === 'gf2'
						? run(x, start) ^ offset
						: BigInt.asUintN(model.bits, run(x, start) - offset),
					`${name} ${length}`
				);
				assert.equal(
					predictEnd(model, start, length, offset),
					run(x, start),
					`${name} ${length}`
				);
			}
		}
	});

	test('a length that is not a multiple of the alignment is rejected', () => {
		const model = probeAffine(readFileSync(paths.sha256c!), 'sha256c', { align: 64 });
		assert.equal(model.kind, 'refusal');
		const crc = probeAffine(readFileSync(paths.crc32c!), 'crc32c', { align: 4 });
		assert.equal(crc.kind, 'model');
		if (crc.kind === 'model') assert.throws(() => advance(crc, 1n, 3), RangeError);
	});
});

function subjectPaths(): [string, string, string][] {
	const list: [string, string, string][] = positive.map((name) => [
		name,
		paths[name]!,
		subjects.find((s) => s.name === name)!.entry
	]);
	if (miniz) list.push(['miniz-crc32', miniz, 'mz_crc32']);
	return list;
}

describe('exact mode', () => {
	test('equals the serial result on every subject over random and ragged chunks', () => {
		for (const [name, wasm, entry] of subjectPaths()) {
			const { model, pool, serial } = session(name, wasm, entry);
			for (const size of [1, 2, 3, 1000, 65536, 200003]) {
				const input = random(size);
				const expected = serial(input);
				const result = foldAffine(pool, input, model);
				assert.equal(result.state, expected, `${name} ${size}`);
				assert.equal(result.mismatchAt, -1, `${name} ${size}`);
				assert.equal(result.fallbackBytes, 0);
			}
			const input = random(90001);
			const chunks = [];
			for (let at = 0; at < input.length;) {
				const end = Math.min(input.length, at + 1 + (next() % 30000));
				chunks.push({ start: at, end });
				at = end;
			}
			assert.equal(foldAffine(pool, input, model, { chunks }).state, serial(input), name);
			const withInitial = BigInt.asUintN(
				model.bits,
				(BigInt(next()) << 32n) | BigInt(next())
			);
			assert.equal(
				foldAffine(pool, input, model, { initial: withInitial, chunks }).state,
				serial(input, withInitial),
				`${name} initial`
			);
		}
	});

	test('empty and one-byte inputs, and a pool of one worker', () => {
		const wasm = paths.crc32c!;
		const { model, serial } = session('crc32c', wasm, 'crc32c');
		const one = start(wasm, model.layout, 1);
		const empty = foldAffine(one, new Uint8Array(0), model, { initial: 5n });
		assert.equal(empty.state, 5n);
		assert.equal(empty.tasks, 0);
		const byte = Uint8Array.of(0x61);
		assert.equal(foldAffine(one, byte, model).state, serial(byte));
		const input = random(40000);
		const chunks = [
			{ start: 0, end: 7 },
			{ start: 7, end: 20000 },
			{ start: 20000, end: 40000 }
		];
		const result = foldAffine(one, input, model, { chunks });
		assert.equal(result.state, serial(input));
		assert.equal(result.validated, 2);
		assert.equal(foldAffine(one, input, model).state, serial(input));
	});

	test('runs 2 n minus 2 tasks for n chunks and none of the extra work for n of one', () => {
		const { model, pool } = session('crc32c', paths.crc32c!, 'crc32c');
		const result = foldAffine(pool, random(100000), model);
		assert.equal(result.chunks, 4);
		assert.equal(result.tasks, 2 * 4 - 2);
		assert.equal(
			foldAffine(pool, random(10), model, { chunks: [{ start: 0, end: 10 }] }).tasks,
			1
		);
	});

	test('invalid chunk ranges throw', () => {
		const { model, pool } = session('crc32c', paths.crc32c!, 'crc32c');
		assert.throws(
			() => foldAffine(pool, random(10), model, { chunks: [{ start: 0, end: 5 }] }),
			RangeError
		);
		assert.throws(
			() =>
				foldAffine(pool, random(10), model, {
					chunks: [
						{ start: 1, end: 5 },
						{ start: 5, end: 10 }
					]
				}),
			RangeError
		);
	});
});

describe('audit mode', () => {
	test('equals the serial result on a function that is affine', () => {
		for (const [name, wasm, entry] of subjectPaths()) {
			const { model, pool, serial } = session(name, wasm, entry);
			const input = random(150000);
			const result = foldAffine(pool, input, model, { mode: 'audit', audit: 2 });
			assert.equal(result.state, serial(input), name);
			assert.equal(result.audited.length, 2);
			assert.equal(result.mismatchAt, -1);
		}
	});
});

describe('adversarial control', () => {
	const size = 262144;
	const at = 100000;
	let input: Uint8Array;
	let wasm: string;
	let trigger: number;

	beforeAll(() => {
		input = random(size);
		// the raw CRC-32 register after `at` bytes from zero is the one value the function reacts to
		const table = Uint32Array.from({ length: 256 }, (_, n) => {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
			return c >>> 0;
		});
		let reg = 0;
		for (let i = 0; i < at; i++) reg = ((reg >>> 8) ^ table[(reg ^ input[i]!) & 255]!) >>> 0;
		trigger = reg;
		wasm = buildAdversarial(trigger);
	}, 60000);

	test('the probe accepts it', () => {
		const model = probeAffine(readFileSync(wasm), 'adv');
		assert.equal(model.kind, 'model');
		if (model.kind === 'model') assert.equal(model.ring, 'gf2');
	});

	test('exact mode records a mismatch, falls back and returns the serial result', () => {
		const { model, pool, serial } = session('adv', wasm, 'adv', 8);
		const expected = serial(input);
		const result = foldAffine(pool, input, model);
		assert.equal(result.state, expected);
		assert.equal(result.mismatchAt, 3);
		assert.ok(result.fallbackBytes > 0);
		assert.ok(result.validated < result.chunks - 1);
	});

	test('audit mode misses the changed chunk for some samples and catches it for others', () => {
		const { model, pool, serial } = session('adv', wasm, 'adv', 8);
		const expected = serial(input);
		let caught = 0;
		let missed = 0;
		for (let s = 1; s <= 24; s++) {
			const result = foldAffine(pool, input, model, { mode: 'audit', audit: 2, seed: s });
			if (result.mismatchAt >= 0) {
				caught++;
				assert.equal(result.state, expected, `seed ${s} caught and fell back`);
			} else {
				missed++;
				assert.notEqual(result.state, expected, `seed ${s} missed and is wrong`);
			}
		}
		assert.ok(caught > 0 && missed > 0, `caught ${caught}, missed ${missed}`);
		const all = foldAffine(pool, input, model, { mode: 'audit', audit: 7 });
		assert.equal(all.state, expected);
		assert.equal(all.mismatchAt, 3);
	});
});

describe('length-sensitive control', () => {
	const size = 262144;
	let input: Uint8Array;
	const wasm: Record<string, string> = {};

	// h = h * 31 + byte, with a bit flipped only when one call covers exactly 262144 bytes
	function build(sensitive: boolean): string {
		const text = `(module (memory (export "memory") 32 512)
			(func (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
				(local $i i32)
				(block $done (loop $again
					(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
					(local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31))
						(i32.load8_u (i32.add (local.get $p) (local.get $i)))))
					(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
				${sensitive ? `(if (i32.eq (local.get $n) (i32.const ${size})) (then (local.set $s (i32.xor (local.get $s) (i32.const 1)))))` : ''}
				(local.get $s)))`;
		const module = binaryen.parseText(text);
		const file = `${mkdtempSync(`${tmpdir()}/folio-length-`)}/${sensitive ? 'sensitive' : 'plain'}.wasm`;
		writeFileSync(file, module.emitBinary());
		module.dispose();
		return file;
	}

	beforeAll(() => {
		input = Uint8Array.from({ length: size }, (_, k) => (k * 17 + 31) & 255);
		wasm.plain = build(false);
		wasm.sensitive = build(true);
	}, 60000);

	test('exact mode equals the unsplit call when the function composes', () => {
		const { model, pool, serial } = session('length-plain', wasm.plain!, 'update');
		const result = foldAffine(pool, input, model);
		assert.equal(result.mismatchAt, -1);
		assert.equal(result.state, serial(input));
	});

	test('exact mode validates the chunk chain and misses a length-dependent difference', () => {
		const { model, pool, serial } = session('length-sensitive', wasm.sensitive!, 'update');
		const result = foldAffine(pool, input, model);
		assert.equal(result.mismatchAt, -1);
		assert.equal(result.fallbackBytes, 0);
		assert.notEqual(result.state, serial(input));
		assert.equal(result.state, serial(input) ^ 1n);
	});
});

describe('spike checkers', () => {
	const instance = (bytes: Uint8Array) =>
		new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes))).exports as Record<
			string,
			any
		>;
	const accepts = (check: () => unknown) => {
		try {
			check();
			return true;
		} catch {
			return false;
		}
	};

	// the model with one zero-start run per chunk reproduces the serial call
	function assertModel(bytes: Uint8Array, entry: string, model: AffineModel) {
		const exports = instance(bytes);
		const update = exports[entry] as Function;
		const heap = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
		heap.set(
			Uint8Array.from(
				{ length: 65537 },
				(_, k) => (Math.imul(k, 2654435761) ^ (k >>> 8)) & 255
			),
			1024
		);
		for (const length of [1, 257, 65537]) {
			for (const initial of [0, 0xffffffff]) {
				const serial = BigInt(update(initial | 0, 1024, length) >>> 0);
				for (const width of [2, 8]) {
					let combined = BigInt(initial);
					for (let k = 0; k < width; k++) {
						const from = Math.floor((k * length) / width);
						const to = Math.floor(((k + 1) * length) / width);
						const offset = BigInt(update(0, 1024 + from, to - from) >>> 0);
						combined = predictEnd(model, combined, to - from, offset);
					}
					assert.equal(combined, serial, `length ${length} width ${width}`);
				}
			}
		}
	}

	test('both refuse a nop with a clean error', () => {
		const loop =
			buildWat(`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
			(block $g (br_if $g (i32.eqz (local.get 2)))
				(loop $l (nop) (local.set 3 (i32.load8_u (local.get 1)))
					(local.set 0 (i32.xor (local.get 0) (local.get 3)))
					(local.set 1 (i32.add (local.get 1) (i32.const 1)))
					(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
			(local.get 0))`);
		assert.throws(() => checkLoop(loop, 'update'), Refusal);
		assert.match(refusalOf(loop, 'update')!, /no readable form/);
		const stream = buildWat(`(func $step (export "transition") (param i32 i32) (result i32)
				(block (result i32) (nop) (i32.xor (local.get 0) (local.get 1))))
			(func $update (export "update") (param i32 i32 i32) (result i32)
				(block $done (br_if $done (i32.eqz (local.get 2)))
					(loop $again (local.set 0 (call $step (local.get 0) (i32.load8_u (local.get 1))))
						(local.set 1 (i32.add (local.get 1) (i32.const 1)))
						(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
				(local.get 0))`);
		assert.throws(() => checkStream(stream), assert.AssertionError);
		assert.throws(() => checkStream(stream), /no readable form/);
	});

	test('the loop checker certifies the clang crc32c', () => {
		const bytes = new Uint8Array(readFileSync(paths.crc32c!));
		const { model, conditioning } = checkLoop(bytes, 'crc32c');
		assert.equal(conditioning, 0xffffffffn);
		const sampled = probeAffine(bytes, 'crc32c');
		assert.equal(sampled.kind, 'model');
		assert.deepEqual(model.operator, (sampled as AffineModel).operator);
		assertModel(bytes, 'crc32c', model);
	});

	test('the loop checker refuses both conditioning edits of the clang crc32c', () => {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		const crc = new Uint8Array(readFileSync(paths.crc32c!));
		// the post-loop xor with -1 that closes the guard block, as binaryen prints it
		const post =
			'   (local.set $0\n    (i32.xor\n     (local.get $0)\n     (i32.const -1)\n    )\n   )\n  )\n  (local.get $0)';
		const refusal = (replacement: string) => {
			const mod = binaryen.readBinary(crc);
			mod.setFeatures(binaryen.Features.All & ~compact);
			const text = mod.emitText();
			mod.dispose();
			assert.ok(text.includes(post));
			const parsed = binaryen.parseText(text.replace(post, replacement));
			parsed.setFeatures(binaryen.Features.All & ~compact);
			const bytes = Uint8Array.from(parsed.emitBinary());
			parsed.dispose();
			return refusalOf(bytes, 'crc32c');
		};
		const cancel = 'conditioning does not cancel across calls';
		assert.equal(refusal('  )\n  (local.get $0)'), cancel);
		assert.equal(refusal(post.replace('-1', '-2')), cancel);
	});

	test('the stream checker accepts the template CRC step and refuses length hazards', () => {
		const module = (id: string) => build(mutants().find((m) => m.id === id)!.text);
		const control = module('control');
		const { model } = checkStream(control);
		assert.equal(model.ring, 'gf2');
		assertModel(control, 'update', model);
		for (const id of ['length-xor', 'length-eq-1000', 'length-eq-262144', 'final-xor'])
			assert.equal(
				accepts(() => checkStream(module(id))),
				false,
				id
			);
	});

	// recorded verdicts of the red-team operator cases: [case, form, accepted]
	const sample: [string, 'stream' | 'loop', boolean][] = [
		['neg-bit0', 'stream', true],
		['shu-32', 'loop', true],
		['tee-state-alias', 'stream', true],
		['set-in-block-first', 'loop', true],
		['neg-mask3', 'stream', false],
		['and-vars', 'loop', false],
		['clz', 'stream', false],
		['mul-odd', 'stream', false],
		['rotl-const', 'stream', false],
		['select', 'loop', false],
		['local-uninit', 'loop', false],
		['tee-reassign', 'loop', false]
	];
	for (const [id, form, expected] of sample) {
		test(`red-team case ${id} in the ${form} form is ${expected ? 'accepted' : 'refused'}`, () => {
			const bytes = buildWat(caseWat(id, form));
			const run =
				form === 'stream' ? () => checkStream(bytes) : () => checkLoop(bytes, 'update');
			assert.equal(accepts(run), expected);
			if (expected) assertModel(bytes, 'update', run().model);
		});
	}
});

// #region state in the context

const contextWorker = new URL('../../scripts/research/affine-context-worker.ts', import.meta.url);

function startContext(wasm: string, subject: ContextSubject, count: number): TaskPool {
	const pool = new TaskPool(count);
	const workers: Worker[] = [];
	for (let index = 0; index < count; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(contextWorker, {
				workerData: {
					link,
					wasm,
					layout: subject.layout,
					context: subject.context,
					state: subject.state
				},
				transferList: [link.port]
			})
		);
	}
	open.push({ pool, workers });
	return pool;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	return c >>> 0;
});
const word = (b: Uint8Array, at: number) =>
	new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const words = (...values: number[]) => {
	const out = new Uint8Array(values.length * 4);
	values.forEach((v, i) => new DataView(out.buffer).setUint32(4 * i, v >>> 0, true));
	return out;
};
function crcRegister(input: Uint8Array, start: number): number {
	let r = start;
	for (const b of input) r = ((r >>> 8) ^ crcTable[(r ^ b) & 255]!) >>> 0;
	return r;
}
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

// independent references in JS, in the order of the state bytes of each subject
const oracle: Record<string, (input: Uint8Array, start: Uint8Array) => Uint8Array> = {
	crcctx: (input, s) => words(crcRegister(input, word(s, 0))),
	crclen: (input, s) => words(crcRegister(input, word(s, 0)), word(s, 4) + input.length),
	fletcher: (input, s) => {
		let s1 = word(s, 0);
		let s2 = word(s, 4);
		for (const b of input) {
			s1 = (s1 + b) >>> 0;
			s2 = (s2 + s1) >>> 0;
		}
		return words(s1, s2);
	},
	polyctx: (input, s) => {
		let h = word(s, 0);
		for (const b of input) h = (Math.imul(h, 31) + b) >>> 0;
		return words(h);
	},
	last8: (input, s) => concat(s, input).slice(-7),
	'aes-ctr': (input, s) => {
		let counter = 0n;
		for (const b of s) counter = (counter << 8n) | BigInt(b);
		counter = (counter + BigInt(Math.ceil(input.length / 16))) & ((1n << 128n) - 1n);
		return Uint8Array.from({ length: 16 }, (_, i) =>
			Number((counter >> BigInt(8 * (15 - i))) & 255n)
		);
	}
};

interface StateSession {
	model: StateModel;
	subject: ContextSubject;
	pool: TaskPool;
	serial: (input: Uint8Array, state?: Uint8Array) => Uint8Array;
}

let ownPaths: Record<string, string>;
let corpusPaths: Record<string, string>;
const stateSessions = new Map<string, StateSession>();

beforeAll(() => {
	ownPaths = buildContextSubjects();
	corpusPaths = buildCorpusContextSubjects();
}, 120000);

function stateSubject(
	name: string
): { wasm: string; entry: string; context: Uint8Array; align: number } | undefined {
	if (name in ownPaths)
		return {
			wasm: ownPaths[name]!,
			entry: `${name}_update`,
			context: ownContext(name),
			align: 1
		};
	const wasm = corpusPaths[name];
	if (!wasm) return undefined;
	return {
		wasm,
		entry: corpusEntry[name]!,
		context: corpusContext(name, wasm),
		align: name === 'aes-ctr' ? 16 : 1
	};
}

function stateSession(name: string, width = 4): StateSession | undefined {
	let found = stateSessions.get(name);
	if (!found) {
		const spec = stateSubject(name);
		if (!spec) return undefined;
		const bytes = readFileSync(spec.wasm);
		const model = probeState(bytes, spec.entry, { context: spec.context, align: spec.align });
		assert.equal(model.kind, 'state', name);
		if (model.kind !== 'state') return undefined;
		const subject = modelSubject(new WebAssembly.Module(bytes), model);
		found = {
			model,
			subject,
			pool: startContext(spec.wasm, subject, width),
			serial: stateSerial(subject)
		};
		stateSessions.set(name, found);
	}
	return found;
}

const positiveState = ['crcctx', 'crclen', 'fletcher', 'polyctx', 'last8', 'aes-ctr'];

describe('state in the context: discovery', () => {
	const probe = (name: string, extra: Partial<Parameters<typeof probeState>[2]> = {}) => {
		const spec = stateSubject(name);
		if (!spec) return undefined;
		return probeState(readFileSync(spec.wasm), spec.entry, {
			context: spec.context,
			align: spec.align,
			...extra
		});
	};
	const model = (name: string): StateModel | undefined => {
		const result = probe(name);
		if (!result) return undefined;
		assert.equal(result.kind, 'state', name);
		return result.kind === 'state' ? result : undefined;
	};
	const range = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => from + i);

	test('crcctx: the register is state and the magic field is a parameter', () => {
		const m = model('crcctx')!;
		assert.deepEqual(m.state, range(4, 7));
		assert.deepEqual(m.params, range(0, 3));
		assert.deepEqual(m.scratch, []);
		assert.deepEqual(
			m.factors.map((f) => f.ring),
			['gf2']
		);
		assert.ok(m.checks.every((c) => c.passed));
	});

	test('crclen: a CRC register and a length counter are two factors in two rings', () => {
		const m = model('crclen')!;
		assert.deepEqual(m.state, range(0, 7));
		assert.deepEqual(
			m.factors.map((f) => [f.ring, f.offsets]),
			[
				['gf2', range(0, 3)],
				['z2w', range(4, 7)]
			]
		);
		// the length counter multiplies by one
		assert.deepEqual(m.factors[1]!.operator, [[1n]]);
	});

	test('fletcher: two interacting words are one matrix over Z/2^32', () => {
		const m = model('fletcher')!;
		assert.equal(m.factors.length, 1);
		assert.equal(m.factors[0]!.ring, 'z2w');
		assert.equal(m.factors[0]!.words, 2);
		assert.deepEqual(m.factors[0]!.operator, [
			[1n, 0n],
			[1n, 1n]
		]);
	});

	test('polyctx: the multiplier in the context is a parameter and the operator is 31', () => {
		const m = model('polyctx')!;
		assert.deepEqual(m.params, range(0, 3));
		assert.deepEqual(m.state, range(4, 7));
		assert.deepEqual(m.factors[0]!.operator, [[31n]]);
	});

	test('last8: the oldest byte is dropped, so seven bytes are state and one is scratch', () => {
		const m = model('last8')!;
		assert.deepEqual(m.state, range(1, 7));
		assert.deepEqual(m.scratch, [0]);
		assert.equal(m.factors[0]!.ring, 'gf2');
	});

	test('aes-ctr: the counter block is one 128-bit big endian integer', () => {
		const m = model('aes-ctr');
		if (!m) return;
		assert.deepEqual(m.state, range(176, 191));
		assert.equal(m.factors.length, 1);
		assert.equal(m.factors[0]!.ring, 'z2w');
		assert.equal(m.factors[0]!.endian, 'be');
		assert.equal(m.factors[0]!.wordBytes, 16);
		assert.deepEqual(m.factors[0]!.operator, [[1n]]);
		assert.deepEqual(m.params, []);
	});

	test('the recovered operators predict the end state on every length', () => {
		for (const name of ['crcctx', 'crclen', 'fletcher', 'polyctx', 'last8']) {
			const s = stateSession(name)!;
			for (const length of [0, 1, 2, 3, 5, 8, 17, 64, 100, 513, 4096]) {
				const x = random(length);
				const start = random(s.model.state.length);
				const zero = new Uint8Array(s.model.state.length);
				const offset = s.serial(x, zero);
				assert.deepEqual(
					predictState(s.model, start, length, offset),
					s.serial(x, start),
					`${name} ${length}`
				);
			}
		}
	});

	for (const name of ['sha256', 'sha1', 'md5', 'xxh32']) {
		test(`${name}: refused, nonlinear over its real context`, () => {
			const result = probe(name);
			if (!result) return;
			assert.equal(result.kind, 'refusal', name);
			if (result.kind !== 'refusal') return;
			assert.match(result.reason, /not additive over GF\(2\) on reachable states/);
			assert.ok(
				result.checks.some((c) => c.name === 'additivity on reachable states' && !c.passed)
			);
			assert.ok(result.calls > 1000);
		});
	}

	test('a counter outside the context that changes on every call is refused', () => {
		const result = probe('hidden');
		assert.equal(result?.kind, 'refusal');
		if (result?.kind === 'refusal')
			assert.match(result.reason, /memory outside the context changed/);
	});

	test('a CRC register and a counter that depends on it are refused as one vector', () => {
		const result = probe('crccouple');
		assert.equal(result?.kind, 'refusal');
		if (result?.kind === 'refusal') {
			assert.match(result.reason, /state bytes 0 to 7 \(8 bytes\) are affine in no ring/);
			assert.ok(result.checks.every((c) => c.factor === 0 && !c.passed));
		}
	});

	test('the same seed gives the same model and call count', () => {
		assert.deepEqual(probe('fletcher', { seed: 7 }), probe('fletcher', { seed: 7 }));
	});

	test('bad options and a missing entry throw', () => {
		const spec = stateSubject('crcctx')!;
		const bytes = readFileSync(spec.wasm);
		assert.throws(() => probeState(bytes, 'crcctx_update', { window: 257 }), RangeError);
		assert.throws(() => probeState(bytes, 'crcctx_update', { window: 0 }), RangeError);
		assert.throws(
			() => probeState(bytes, 'crcctx_update', { window: 8, context: new Uint8Array(9) }),
			RangeError
		);
		assert.throws(() => probeState(bytes, 'nothing'));
	});
});

describe('state in the context: exact mode', () => {
	test('equals the serial result and the JS reference on every subject', () => {
		for (const name of positiveState) {
			const s = stateSession(name);
			if (!s) continue;
			const align = s.model.align;
			for (const size of [1, 2, 3, 1000, 65536, 200003]) {
				const input = random(size);
				const expected = s.serial(input);
				const start = pick(s.model.context, s.model.state);
				assert.deepEqual(expected, oracle[name]!(input, start), `${name} ${size} oracle`);
				const result = foldState(s.pool, input, s.model);
				assert.deepEqual(result.state, expected, `${name} ${size}`);
				assert.equal(result.mismatchAt, -1, `${name} ${size}`);
				assert.equal(result.fallbackBytes, 0);
			}
			const input = random(90001);
			const chunks = [];
			for (let at = 0; at < input.length;) {
				const end = Math.min(input.length, at + align * (1 + (next() % 1800)));
				chunks.push({ start: at, end });
				at = end;
			}
			const initial = random(s.model.state.length);
			const expected = s.serial(input, initial);
			assert.deepEqual(expected, oracle[name]!(input, initial), `${name} initial oracle`);
			assert.deepEqual(
				foldState(s.pool, input, s.model, { chunks, initial }).state,
				expected,
				name
			);
		}
	});

	test('empty, one byte, one chunk, a pool of one worker and a chunk count of n', () => {
		const s = stateSession('crclen')!;
		const initial = random(8);
		const empty = foldState(s.pool, new Uint8Array(0), s.model, { initial });
		assert.deepEqual(empty.state, initial);
		assert.equal(empty.tasks, 0);
		const byte = Uint8Array.of(0x61);
		assert.deepEqual(foldState(s.pool, byte, s.model).state, s.serial(byte));
		const input = random(40000);
		const one = startContext(ownPaths.crclen!, s.subject, 1);
		const chunks = [
			{ start: 0, end: 7 },
			{ start: 7, end: 20000 },
			{ start: 20000, end: 40000 }
		];
		const result = foldState(one, input, s.model, { chunks });
		assert.deepEqual(result.state, s.serial(input));
		assert.equal(result.validated, 2);
		const whole = foldState(s.pool, input, s.model, { chunks: [{ start: 0, end: 40000 }] });
		assert.equal(whole.tasks, 1);
		assert.deepEqual(whole.state, s.serial(input));
		const four = foldState(s.pool, random(100000), s.model);
		assert.equal(four.chunks, 4);
		assert.equal(four.tasks, 2 * 4 - 2);
	});

	test('invalid chunk ranges and an unaligned chunk throw', () => {
		const s = stateSession('crclen')!;
		assert.throws(
			() => foldState(s.pool, random(10), s.model, { chunks: [{ start: 0, end: 5 }] }),
			RangeError
		);
		assert.throws(
			() => foldState(s.pool, random(10), s.model, { initial: new Uint8Array(3) }),
			RangeError
		);
		const aes = stateSession('aes-ctr');
		if (!aes) return;
		assert.throws(
			() =>
				foldState(aes.pool, random(100), aes.model, {
					chunks: [
						{ start: 0, end: 50 },
						{ start: 50, end: 100 }
					]
				}),
			RangeError
		);
	});

	test('the exact fold of AF1 is unchanged by the shared core', () => {
		const { model, pool, serial } = session('crc32c', paths.crc32c!, 'crc32c');
		const input = random(150001);
		const result = foldAffine(pool, input, model);
		assert.equal(result.state, serial(input));
		assert.equal(result.tasks, 2 * result.chunks - 2);
	});
});

describe('state in the context: adversarial control', () => {
	const size = 262144;
	const at = 100000;
	let input: Uint8Array;
	let wasm: string;

	beforeAll(() => {
		input = random(size);
		wasm = buildAdversarialContext(crcRegister(input.subarray(0, at), 0));
	}, 60000);

	test('the probe accepts it, exact mode records a mismatch and returns the serial result', () => {
		const bytes = readFileSync(wasm);
		const model = probeState(bytes, 'advctx_update');
		assert.equal(model.kind, 'state');
		if (model.kind !== 'state') return;
		assert.equal(model.factors[0]!.ring, 'gf2');
		const subject = modelSubject(new WebAssembly.Module(bytes), model);
		const pool = startContext(wasm, subject, 8);
		const expected = stateSerial(subject)(input);
		assert.notDeepEqual(expected, words(crcRegister(input, 0)), 'the trigger fired');
		const result = foldState(pool, input, model);
		assert.deepEqual(result.state, expected);
		assert.equal(result.mismatchAt, 3);
		assert.ok(result.fallbackBytes > 0);
	});
});

// #endregion
