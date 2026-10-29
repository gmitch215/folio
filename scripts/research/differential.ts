import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
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

if (import.meta.main) {
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
