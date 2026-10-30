import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { admissionSeam } from '../../src/iteration-admission.ts';
import { Folio, type ExecutionReport } from '../../src/node.ts';
import { digest, researchEnvironment } from './environment.ts';

export function random(seed: number) {
	let value = seed >>> 0 || 1;
	return () => {
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		return value >>> 0;
	};
}

/** A bounded scalar grammar; seeds vary instructions, widths, offsets and constants. */
export function generatedProgram(seed: number) {
	const next = random(seed),
		shape = next() % 7,
		offset = next() % 4,
		constant = next() | 1 | 0;
	const src = `(i32.add (local.get $src) (i32.const ${offset}))`;
	const dst = `(i32.add (local.get $dst) (i32.const ${offset}))`;
	const bodies = [
		`(i32.store align=1 ${dst} (i32.xor (i32.rotl (i32.load align=1 ${src}) (local.get $salt)) (i32.const ${constant})))`,
		`(i64.store align=1 ${dst} (i64.add (i64.load align=1 ${src}) (i64.extend_i32_s (local.get $salt))))`,
		`(memory.copy ${dst} ${src} (i32.const ${1 + (next() % 12)}))`,
		`(f32.store align=1 ${dst} (f32.load align=1 ${src}))`,
		`(f64.store align=1 ${dst} (f64.load align=1 ${src}))`,
		`(i32.store align=1 ${dst} (i32.trunc_sat_f64_s (f64.load align=1 ${src})))`,
		`(i32.store16 align=1 ${dst} (i32.add (i32.load8_s ${src}) (i32.clz (local.get $salt))))`
	];
	const wat = `(module
		(import "env" "memory" (memory 1 4 shared))
		(import "host" "observe" (func $observe (param i32)))
		(func $job (param $dst i32) (param $src i32) (param $salt i32) (param $trap i32)
			(i32.store8 (local.get $dst) (i32.const 91))
			${bodies[shape]}
			(if (local.get $trap) (then (unreachable))))
		(func (export "main") (param $count i32) (param $mode i32) (result i32) (local $i i32)
			(call $observe (i32.const -1))
			(block $done (loop $again
				(br_if $done (i32.ge_u (local.get $i) (local.get $count)))
				(call $job
					(select (i32.const 65533)
						(select (i32.const 512) (i32.add (i32.const 512) (i32.mul (local.get $i) (i32.const 16)))
							(i32.and (local.get $mode) (i32.const 1)))
						(i32.and (local.get $mode) (i32.const 4)))
					(select
						(select (i32.const 256) (i32.add (i32.const 496) (i32.mul (local.get $i) (i32.const 16)))
							(i32.eqz (local.get $i)))
						(i32.add (i32.const 256) (i32.mul (local.get $i) (i32.const 16)))
						(i32.and (local.get $mode) (i32.const 2)))
					(i32.xor (local.get $i) (i32.const ${constant}))
					(i32.and (local.get $mode) (i32.const 8)))
				${seed % 3 === 0 ? '(if (i32.eq (local.get $i) (i32.const 3)) (then (call $observe (local.get $i))))' : ''}
				(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
			(call $observe (i32.const 99)) (i32.load (i32.const 512))))`;
	return { seed, shape, wat };
}

function compile(wat: string) {
	const module = binaryen.parseText(wat);
	try {
		module.setFeatures(binaryen.Features.All);
		assert.ok(module.validate());
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

function seedMemory(memory: WebAssembly.Memory, seed: number) {
	const next = random(seed),
		bytes = new Uint8Array(memory.buffer);
	for (let index = 0; index < bytes.length; index++) bytes[index] = next() & 255;
	// Include payload NaNs, signed zero and high bits in otherwise random inputs.
	const view = new DataView(memory.buffer);
	for (let index = 256; index < 512; index += 8)
		view.setBigUint64(index, 0x7ff8123456789abcn, true);
}

const errorOf = (error: unknown) =>
	error instanceof Error
		? { name: error.name, message: error.message }
		: { name: typeof error, message: String(error) };

export async function runDifferential(options: {
	seed: number;
	programs: number;
	widths: number[];
	emit: (row: Record<string, unknown>) => void;
}) {
	assert.ok(
		Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff,
		'seed must be a uint32'
	);
	assert.ok(
		Number.isInteger(options.programs) && options.programs > 0,
		'programs must be a positive integer'
	);
	assert.ok(
		options.widths.length > 0 &&
			options.widths.every((width) => Number.isInteger(width) && width > 0 && width <= 32),
		'widths must be integers from 1 to 32'
	);
	const totals = {
		programs: 0,
		comparisons: 0,
		traps: 0,
		hostThrows: 0,
		replayed: 0,
		dispatched: 0,
		nativeShared: 0,
		speculative: 0,
		guardFallback: 0
	};
	const compare = async (
		bytes: Uint8Array,
		entry: string,
		inputs: number[][],
		seed: number,
		sharedGuard = false
	) => {
		const prepared = prepare(bytes, { minimumRegionWork: 0 });
		const module = new WebAssembly.Module(Uint8Array.from(bytes));
		for (const width of options.widths) {
			const actual = new WebAssembly.Memory({
				initial: sharedGuard ? 2 : 1,
				maximum: sharedGuard ? 8192 : 4,
				shared: true
			});
			const expected = new WebAssembly.Memory({
				initial: sharedGuard ? 2 : 1,
				maximum: sharedGuard ? 8192 : 4,
				shared: true
			});
			let effects: unknown[] = [],
				referenceEffects: unknown[] = [],
				throws = false;
			const hostError = new Error('generated host exception');
			const observe = (memory: WebAssembly.Memory, log: unknown[]) => (tag: number) => {
				log.push([tag, new DataView(memory.buffer).getUint32(512, true)]);
				if (tag === 99 && throws) throw hostError;
			};
			const native = new WebAssembly.Instance(module, {
				env: { memory: expected },
				host: { observe: observe(expected, referenceEffects) }
			});
			const pool = await Folio.open(prepared, {
				memory: actual,
				workers: width,
				minimumRegionWork: 0,
				minimumParallelWork: 0,
				imports: { host: { observe: observe(actual, effects) } }
			});
			try {
				for (let trial = 0; trial < inputs.length; trial++) {
					const args = inputs[trial]!;
					seedMemory(actual, seed + trial);
					new Uint8Array(expected.buffer).set(new Uint8Array(actual.buffer));
					effects.length = 0;
					referenceEffects.length = 0;
					throws = !sharedGuard && trial % 5 === 4;
					let value: unknown,
						error: unknown,
						actualError: unknown,
						report: Awaited<ReturnType<Folio['run']>> | undefined;
					try {
						value = (native.exports[entry] as CallableFunction)(...args);
					} catch (caught) {
						error = caught;
					}
					try {
						report = await pool.run(entry, args);
					} catch (caught) {
						actualError = caught;
					}
					const context = `seed=${seed} width=${width} entry=${entry} trial=${trial}`;
					assert.deepEqual(
						error === undefined ? undefined : errorOf(actualError),
						error === undefined ? undefined : errorOf(error),
						context
					);
					assert.equal(Boolean(actualError), Boolean(error), context);
					if (error === hostError) {
						assert.equal(actualError, hostError, context);
						totals.hostThrows++;
					}
					if (!error) assert.deepEqual(report!.values, [value], context);
					else totals.traps++;
					assert.deepEqual(effects, referenceEffects, context);
					assert.ok(
						Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer)),
						context
					);
					totals.comparisons++;
					totals.dispatched += (report?.workers ?? 0) > 0 ? 1 : 0;
					totals.replayed += report?.replayed ?? 0;
					if (report?.mode === 'native-shared') totals.nativeShared++;
					if (report?.mode === 'speculative') totals.speculative++;
					if (report?.reason === 'guard-failed') totals.guardFallback++;
					options.emit({
						kind: 'comparison',
						seed,
						width,
						trial,
						entry,
						args,
						memorySha256: digest(new Uint8Array(actual.buffer)),
						effects,
						value: typeof value === 'bigint' ? String(value) : value,
						trap: error === undefined ? undefined : errorOf(error),
						report,
						passed: true
					});
				}
			} finally {
				await pool.close();
			}
		}
	};
	for (let index = 0; index < options.programs; index++) {
		const program = generatedProgram((options.seed + index * 2654435761) >>> 0);
		options.emit({ kind: 'program', ...program });
		const inputs = Array.from({ length: 12 }, (_, trial) => [
			trial === 0 ? 0 : 1 + ((trial * 7 + index) % 17),
			[0, 1, 2, 3, 0, 4, 5, 8, 9, 2, 3, 0][trial]!
		]);
		try {
			await compare(compile(program.wat), 'main', inputs, program.seed);
		} catch (error) {
			options.emit({ kind: 'failure', ...program, error: errorOf(error) });
			throw error;
		}
		totals.programs++;
	}
	const fixture = new Uint8Array(
		readFileSync(new URL('../../build/fixture.wasm', import.meta.url))
	);
	await compare(
		fixture,
		'program',
		[
			[1024, 37, 17],
			[1025, 17, 31],
			[0xfffffff0, 17, 3],
			[1024, 0, 3]
		],
		options.seed,
		true
	);
	await compare(
		fixture,
		'aliased_program',
		[
			[1024, 17, 7],
			[65532, 2, 7]
		],
		options.seed,
		true
	);
	// 4-byte stores at a 1, 2 and 4 byte stride overlap at region boundaries unless the stride is 4
	for (const step of [1, 2, 4]) {
		const overlap = binaryen.parseText(`(module (import "env" "memory" (memory 1 8192 shared))
			(func $w (param $p i32) (i32.store (local.get $p) (i32.add (local.get $p) (i32.const 7))))
			(func (export "overlap") (param $p i32) (param $n i32)
				(block $b
					(br_if $b (i32.eqz (local.get $n)))
					(loop $l
						(call $w (local.get $p))
						(local.set $p (i32.add (local.get $p) (i32.const ${step})))
						(br_if $l (local.tee $n (i32.add (local.get $n) (i32.const -1))))))))`);
		overlap.setFeatures(binaryen.Features.All);
		const bytes = overlap.emitBinary();
		overlap.dispose();
		await compare(
			bytes,
			'overlap',
			[
				[512, 64],
				[513, 17],
				[512, 1],
				[512, 0],
				[131000, 300]
			],
			options.seed + step,
			true
		);
	}
	return totals;
}

// #region iteration family
type Emit = (row: Record<string, unknown>) => void;

// owner programs of the iteration route, one per shape; the seed picks the parameters
const iterationPages = 32;
const iterationMaximum = 128;
const iterationTable = 0x10000;
const srcCell = (i: number) => 0x20000 + 64 * i;
const dstCell = (i: number) => 0x30000 + 64 * i;
// iteration 0 runs serially and the first batch holds iterations 1 to 32, so a hazard between
// two of them replays in that batch
const firstBatch = 32;
const page = 65536;

export const iterationShapes = [
	'disjoint',
	'raw',
	'war',
	'waw',
	'framed',
	'frame-carried',
	'trap',
	'mixed'
] as const;
export type IterationShape = (typeof iterationShapes)[number];
type Hazard = 'raw' | 'war' | 'waw';

const plainBody =
	'(i32.store (local.get $dst) (i32.add (i32.load (local.get $src)) (i32.const 3)))';
const trapBody = '(if (i32.eq (i32.load (local.get $src)) (i32.const 777)) (then (unreachable)))';
const divBody =
	'(i32.store (local.get $dst) (i32.div_u (i32.const 1000) (i32.load (local.get $src))))';
const framedBody = (depth: number) => `
	(i32.store (local.get $f) (i32.load (local.get $src)))
	(i32.store (local.get $dst) (call $visit (local.get $f) (i32.const ${depth})))`;
const carriedBody = `
	(i32.store (local.get $f) (i32.add (i32.load (local.get $f)) (i32.load (local.get $src))))
	(i32.store (local.get $dst) (i32.load (local.get $f)))`;
// adds the depth to the object in the owner frame at each level, then returns it
const visitFunction = `(func $visit (param $f i32) (param $d i32) (result i32) (local $s i32) (local $r i32)
		(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $s))
		(i32.store (local.get $s) (local.get $d))
		(i32.store (local.get $f) (i32.add (i32.load (local.get $f)) (local.get $d)))
		(local.set $r (if (result i32) (i32.eqz (local.get $d))
			(then (i32.load (local.get $f)))
			(else (call $visit (local.get $f) (i32.sub (local.get $d) (i32.const 1))))))
		(global.set $sp (i32.add (local.get $s) (i32.const 16)))
		(local.get $r))`;

function iterationSource(item: string, extra = '') {
	return `(module
		(import "env" "memory" (memory ${iterationPages} ${iterationMaximum}))
		(global $sp (mut i32) (i32.const 65536))
		(func $item (param $t i32) (param $f i32) (local $src i32) (local $dst i32) (local $s i32)
			(local.set $src (i32.load (local.get $t)))
			(local.set $dst (i32.load offset=4 (local.get $t)))
			${item})
		(func $run (export "run") (param $t i32) (param $n i32) (result i32) (local $frame i32) (local $c i32)
			(local.set $frame (i32.sub (global.get $sp) (i32.const 64)))
			(global.set $sp (local.get $frame))
			(i32.store (local.get $frame) (i32.const 0))
			(block $done
				(br_if $done (i32.eqz (local.get $n)))
				(local.set $c (local.get $n))
				(loop $each
					(call $item (local.get $t) (local.get $frame))
					(local.set $t (i32.add (local.get $t) (i32.const 8)))
					(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))))
			(global.set $sp (i32.add (local.get $frame) (i32.const 64)))
			(i32.add (local.get $t) (local.get $c)))
		${extra})`;
}

function compileOwner(wat: string): Uint8Array {
	binaryen.setDebugInfo(true);
	const module = binaryen.parseText(wat);
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		module.setFeatures(binaryen.Features.All & ~compact);
		assert.ok(module.validate(), 'invalid iteration program');
		return module.emitBinary();
	} finally {
		module.dispose();
		binaryen.setDebugInfo(false);
	}
}

// one hazard at a seed-chosen place among iterations 1 to `window`, the first batch
function placeHazard(
	kind: Hazard,
	src: number[],
	dst: number[],
	window: number,
	next: () => number
) {
	if (kind === 'raw') {
		const k = 2 + (next() % (window - 1));
		src[k] = dstCell(k - 1);
	} else if (kind === 'war') {
		const j = 1 + (next() % (window - 1));
		const k = j + 1 + (next() % (window - j));
		src[j] = dstCell(k);
	} else {
		const p = 2 + (next() % (window - 1));
		dst[p] = dstCell(p - 1);
	}
}

export interface IterationProgram {
	seed: number;
	shape: IterationShape;
	trip: number;
	wat: string;
	bytes: Uint8Array;
	image: Uint8Array;
	args: number[];
}

export function iterationProgram(seed: number, shape: IterationShape): IterationProgram {
	const next = random((Math.imul(seed, 8) + iterationShapes.indexOf(shape) + 1) >>> 0);
	const trip = 4 + (next() % 37);
	const window = Math.min(trip - 1, firstBatch);
	const src = Array.from({ length: trip }, (_, i) => srcCell(i));
	const dst = Array.from({ length: trip }, (_, i) => dstCell(i));
	const values = Array.from({ length: trip }, () => 1 + (next() % 500));
	let body = plainBody;
	let extra = '';
	switch (shape) {
		case 'disjoint':
			break;
		case 'raw':
		case 'war':
		case 'waw':
			placeHazard(shape, src, dst, window, next);
			break;
		case 'framed':
			body = framedBody(next() % 7);
			extra = visitFunction;
			break;
		case 'frame-carried':
			body = carriedBody;
			break;
		case 'trap': {
			const at = next() % trip;
			if (next() % 2) {
				values[at] = 777;
				body = trapBody + plainBody;
			} else {
				values[at] = 0;
				body = divBody;
			}
			break;
		}
		case 'mixed': {
			if (next() % 2) body = plainBody;
			else {
				body = framedBody(next() % 7);
				extra = visitFunction;
			}
			const hazards: Hazard[] = ['raw', 'war', 'waw'];
			const count = Math.min(1 + (next() % 4), Math.max(1, Math.floor(trip / 4)));
			for (let n = 0; n < count; n++)
				placeHazard(hazards[next() % 3]!, src, dst, window, next);
			break;
		}
	}
	const image = new Uint8Array(iterationPages * page);
	for (let at = iterationTable; at < 0x40000; at++) image[at] = next() & 255;
	const view = new DataView(image.buffer);
	for (let i = 0; i < trip; i++) {
		view.setUint32(iterationTable + 8 * i, src[i]!, true);
		view.setUint32(iterationTable + 8 * i + 4, dst[i]!, true);
		view.setUint32(srcCell(i), values[i]!, true);
		view.setUint32(dstCell(i), 0xab000000 + i, true);
	}
	const wat = iterationSource(body, extra);
	return {
		seed,
		shape,
		trip,
		wat,
		bytes: compileOwner(wat),
		image,
		args: [iterationTable, trip]
	};
}

// memory outside the stack zone [0, 65536); the arena sits above the declared pages
const programPages = (memory: WebAssembly.Memory) =>
	new Uint8Array(memory.buffer, page, (iterationPages - 1) * page);

type Settled<T> = { value?: T; error?: unknown };
async function settle<T>(call: () => T | Promise<T>): Promise<Settled<T>> {
	try {
		return { value: await call() };
	} catch (error) {
		return { error };
	}
}

const sameFailure = (a: unknown, b: unknown) => {
	if (a === undefined || b === undefined) return a === b;
	const x = errorOf(a),
		y = errorOf(b);
	return x.name === y.name && x.message === y.message;
};

function propertyFailures(
	shape: IterationShape,
	report: ExecutionReport | undefined,
	tag: string
): string[] {
	const replayed = report?.replayed ?? 0;
	switch (shape) {
		case 'disjoint':
		case 'framed':
			return replayed === 0 && report?.extraction === 'iteration'
				? []
				: [`${tag}: replayed ${replayed}, extraction ${report?.extraction}`];
		case 'raw':
		case 'war':
		case 'waw':
			return replayed > 0 ? [] : [`${tag}: no replay`];
		case 'frame-carried':
			return report?.reason === 'frame-carried dependence'
				? []
				: [`${tag}: reason ${report?.reason}`];
		default:
			return [];
	}
}

// the serial program, then the same program through Folio.open and run at one width, dispatched
// and with parallel off; returns one message per failed check
async function checkIterationProgram(
	program: IterationProgram,
	widths: number[],
	emit: Emit
): Promise<string[]> {
	const { seed, shape, bytes, image, args } = program;
	const where = (extra: string) => `seed=${seed} shape=${shape} ${extra}`;
	const found: string[] = [];
	const reference = new WebAssembly.Memory({
		initial: iterationPages,
		maximum: iterationMaximum
	});
	new Uint8Array(reference.buffer).set(image);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory: reference }
	});
	const want = await settle(() => (instance.exports.run as CallableFunction)(...args));
	if (shape === 'trap' && want.error === undefined) found.push(where('native did not trap'));
	for (const width of widths) {
		const host = new WebAssembly.Memory({
			initial: iterationPages,
			maximum: iterationMaximum,
			shared: true
		});
		const folio = await Folio.open(bytes, { memory: host, workers: width });
		try {
			for (const arm of ['dispatch', 'serial'] as const) {
				new Uint8Array(host.buffer).set(image);
				const got = await settle(() =>
					folio.run('run', args, arm === 'serial' ? { parallel: 'off' } : {})
				);
				const report = got.value;
				const tag = where(`width=${width} arm=${arm}`);
				const armFound: string[] = [];
				if (!sameFailure(want.error, got.error)) armFound.push(`${tag}: error differs`);
				if (want.error === undefined && report?.values[0] !== want.value)
					armFound.push(`${tag}: value differs`);
				if (Buffer.compare(programPages(reference), programPages(host)) !== 0)
					armFound.push(`${tag}: memory differs`);
				if (arm === 'dispatch') armFound.push(...propertyFailures(shape, report, tag));
				emit({
					kind: 'comparison',
					family: 'iteration',
					seed,
					shape,
					width,
					arm,
					trip: program.trip,
					value: report?.values[0],
					trap: got.error === undefined ? undefined : errorOf(got.error),
					replayed: report?.replayed,
					extraction: report?.extraction,
					reason: report?.reason,
					mode: report?.mode,
					passed: armFound.length === 0
				});
				found.push(...armFound);
			}
		} finally {
			await folio.close();
		}
	}
	return found;
}

export async function runIterationPrograms(
	programs: { seed: number; shape: IterationShape }[],
	options: { widths: number[]; emit: Emit }
) {
	const saved = { ...admissionSeam };
	admissionSeam.force = true;
	admissionSeam.scale = 1;
	const shapes: Record<string, { programs: number; passed: number }> = {};
	const failures: { seed: number; shape: IterationShape; message: string }[] = [];
	const timings: number[] = [];
	let passed = 0;
	try {
		for (const { seed, shape } of programs) {
			const started = performance.now();
			const program = iterationProgram(seed, shape);
			options.emit({
				kind: 'program',
				family: 'iteration',
				seed,
				shape,
				trip: program.trip,
				wat: program.wat
			});
			let found: string[];
			try {
				found = await checkIterationProgram(program, options.widths, options.emit);
			} catch (error) {
				found = [`seed=${seed} shape=${shape}: threw ${String(error)}`];
			}
			const row = (shapes[shape] ??= { programs: 0, passed: 0 });
			row.programs++;
			if (found.length === 0) {
				row.passed++;
				passed++;
			}
			for (const message of found) {
				failures.push({ seed, shape, message });
				options.emit({ kind: 'failure', family: 'iteration', seed, shape, message });
			}
			timings.push(performance.now() - started);
		}
	} finally {
		Object.assign(admissionSeam, saved);
	}
	return { programs: programs.length, passed, shapes, failures, timings };
}
// #endregion

if (import.meta.main && process.argv[2] === 'iteration') {
	const [directory, seedsArg = '200', baseArg = '12648430'] = process.argv.slice(3);
	if (!directory)
		throw new Error('usage: differential.ts iteration OUTPUT_DIRECTORY [SEEDS] [BASE_SEED]');
	mkdirSync(directory, { recursive: true });
	const output = join(directory, 'raw.jsonl');
	writeFileSync(output, '', { flag: 'wx' });
	const seeds = Number(seedsArg);
	const base = Number(baseArg);
	const widths = [2, 4, 8];
	const emit: Emit = (row) => appendFileSync(output, JSON.stringify(row) + '\n');
	emit(
		researchEnvironment({ family: 'iteration', seeds, base, widths, shapes: iterationShapes })
	);
	const programs = iterationShapes.flatMap((shape) =>
		Array.from({ length: seeds }, (_, i) => ({ seed: (base + i) >>> 0, shape }))
	);
	const { timings, ...summary } = await runIterationPrograms(programs, { widths, emit });
	writeFileSync(
		join(directory, 'summary.json'),
		JSON.stringify(
			{
				...summary,
				seeds,
				base,
				widths,
				rawSha256: digest(readFileSync(output)),
				formalProof: false
			},
			null,
			2
		) + '\n'
	);
	console.log(JSON.stringify(summary));
	process.exitCode = summary.failures.length ? 1 : 0;
}

if (import.meta.main && process.argv[2] !== 'iteration') {
	const [directory, programsArg = '128', seedArg = '12648430'] = process.argv.slice(2);
	if (!directory) throw new Error('usage: differential.ts OUTPUT_DIRECTORY [PROGRAMS] [SEED]');
	mkdirSync(directory, { recursive: true });
	const output = join(directory, 'raw.jsonl');
	writeFileSync(output, '', { flag: 'wx' });
	const options = { seed: Number(seedArg), programs: Number(programsArg), widths: [1, 2, 4, 8] };
	const emit = (row: Record<string, unknown>) =>
		appendFileSync(output, JSON.stringify(row) + '\n');
	emit(researchEnvironment(options));
	const summary = await runDifferential({ ...options, emit });
	writeFileSync(
		join(dirname(output), 'summary.json'),
		JSON.stringify(
			{
				...summary,
				seed: options.seed,
				widths: options.widths,
				rawSha256: digest(readFileSync(output)),
				formalProof: false
			},
			null,
			2
		) + '\n'
	);
	console.log(JSON.stringify(summary));
}
