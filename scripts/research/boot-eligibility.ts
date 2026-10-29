import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	applyImage,
	bakeModule,
	captureImage,
	checkBaked,
	encodeImage,
	ImageMismatchError
} from '../../src/bake.ts';
import { corpusManifest } from './corpus.ts';
import { digest, researchEnvironment } from './environment.ts';

function compile(text: string) {
	const m = binaryen.parseText(text);
	try {
		m.setFeatures(binaryen.Features.All);
		assert.ok(m.validate());
		return m.emitBinary();
	} finally {
		m.dispose();
	}
}

if (import.meta.main) {
	const [directory, pairsArg = '15'] = process.argv.slice(2),
		pairs = Number(pairsArg);
	assert.ok(directory && Number.isSafeInteger(pairs) && pairs > 0);
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	emit(
		researchEnvironment({
			pairs,
			scope: 'fixed deterministic corpus initializers plus synthetic replay counterexamples',
			deployment: false
		})
	);
	for (const kernel of corpusManifest.cases) {
		const bytes = new Uint8Array(
				readFileSync(`build/research/corpus/artifacts/${kernel.id}.wasm`)
			),
			moduleHash = digest(bytes);
		const start = performance.now(),
			module = new WebAssembly.Module(bytes),
			compileMs = performance.now() - start;
		const fresh = () => {
			const memory = new WebAssembly.Memory({ initial: 128, maximum: 1024 });
			const instance = new WebAssembly.Instance(module, {
				env: { memory, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, floor: Math.floor }
			});
			return { memory, exports: instance.exports as Record<string, CallableFunction> };
		};
		const initialized = fresh(),
			baseline = new Uint8Array(initialized.memory.buffer).slice();
		initialized.exports.initialize!();
		const context = digest(
			JSON.stringify({
				moduleHash,
				inputs: corpusManifest.scope,
				case: kernel.id,
				adapter: digest(readFileSync('scripts/research/cases/kernel.c'))
			})
		);
		const image = captureImage(initialized.memory, baseline, { module: moduleHash, context });
		const applicationCache = new Uint8Array(initialized.memory.buffer).slice();
		const value = String(initialized.exports.entry!()),
			expected = new Uint8Array(initialized.memory.buffer).slice();
		let baked: Uint8Array | undefined, refusal: string | undefined;
		try {
			baked = await bakeModule(bytes, image);
		} catch (error) {
			assert.ok(error instanceof ImageMismatchError);
			refusal = error.code;
		}
		emit({
			kind: 'eligibility',
			case: kernel.id,
			moduleSha256: moduleHash,
			context,
			compileMs,
			sourceBytes: bytes.length,
			imageBytes: encodeImage(image).length,
			imageGzipBytes: gzipSync(encodeImage(image)).length,
			applicationCacheBytes: applicationCache.length,
			deltaPages: image.pages.length,
			bakedBytes: baked?.length,
			bakedRefusal: refusal,
			configurationCount: 1,
			safety: 'only this fixed initialized input and host ABI checked; opaque host state not serialized'
		});
		for (let round = -2; round < pairs; round++) {
			const names = ['initialize', 'image', 'application-cache'];
			for (let turn = 0; turn < names.length; turn++) {
				const arm = names[(turn + round + 2) % names.length]!,
					cpu = process.cpuUsage(),
					started = performance.now(),
					state = fresh();
				if (arm === 'initialize') state.exports.initialize!();
				else if (arm === 'image')
					applyImage(state.memory, image, { module: moduleHash, context });
				else new Uint8Array(state.memory.buffer).set(applicationCache);
				const openMs = performance.now() - started,
					entry = performance.now(),
					output = String(state.exports.entry!());
				const entryMs = performance.now() - entry,
					used = process.cpuUsage(cpu);
				assert.equal(output, value);
				assert.ok(Buffer.from(state.memory.buffer).equals(Buffer.from(expected)));
				if (round >= 0)
					emit({
						kind: 'sample',
						case: kernel.id,
						arm,
						round,
						openMs,
						entryMs,
						wallMs: openMs + entryMs,
						cpuMs: (used.user + used.system) / 1000,
						memorySha256: digest(expected),
						passed: true
					});
			}
		}
		const target = fresh(),
			before = digest(new Uint8Array(target.memory.buffer));
		assert.throws(
			() => applyImage(target.memory, image, { context: 'changed-configuration' }),
			(error: unknown) => error instanceof ImageMismatchError && error.code === 'context'
		);
		assert.equal(digest(new Uint8Array(target.memory.buffer)), before);
		emit({ kind: 'invalidation', case: kernel.id, refusedBeforeWrite: true });
	}

	// Explicit counterexamples: a memory image cannot identify external resources or renew secrets.
	const unsafe = compile(`(module
		(import "host" "resource" (func $resource (param i32) (result i32)))
		(memory (export "memory") 1)
		(func (export "boot") (param $secret i32) (param $rng i32) (param $handle i32)
			(i32.store (i32.const 0) (local.get $secret)) (i32.store (i32.const 4) (local.get $rng)) (i32.store (i32.const 8) (local.get $handle)))
		(func (export "read") (result i32) (call $resource (i32.load (i32.const 8)))))`);
	const module = new WebAssembly.Module(Uint8Array.from(unsafe)),
		make = (resources: Map<number, number>) => {
			const instance = new WebAssembly.Instance(module, {
				host: {
					resource: (handle: number) => {
						assert.ok(resources.has(handle), 'stale host handle');
						return resources.get(handle)!;
					}
				}
			});
			return {
				memory: instance.exports.memory as WebAssembly.Memory,
				exports: instance.exports as Record<string, CallableFunction>
			};
		};
	const captured = make(new Map([[7, 42]])),
		before = new Uint8Array(captured.memory.buffer).slice();
	captured.exports.boot!(123456, 765432, 7);
	const image = captureImage(captured.memory, before, {
		module: digest(unsafe),
		context: 'config-one'
	});
	const replay = make(new Map([[9, 99]]));
	applyImage(replay.memory, image, { module: digest(unsafe), context: 'config-one' });
	assert.throws(() => replay.exports.read!(), /stale host handle/);
	const words = new Uint32Array(replay.memory.buffer);
	assert.equal(words[0], 123456);
	assert.equal(words[1], 765432);
	emit({
		kind: 'safety',
		case: 'opaque-state',
		staleSecretReplayed: true,
		rngStateRepeated: true,
		staleHandleRefusedByHost: true,
		structuralCheckDoesNotProveReplaySafety: checkBaked(await bakeModule(unsafe, image), image)
			.equal
	});
	// Caller-owned renewal and rebinding are the workaround, after digest/config validation.
	words[0] = 654321;
	words[1] = 234567;
	words[2] = 9;
	assert.equal(replay.exports.read!(), 99);
	emit({
		kind: 'safety',
		case: 'renew-and-rebind',
		secretRenewed: words[0] !== 123456,
		rngRenewed: words[1] !== 765432,
		reboundResource: 99,
		passed: true
	});
	for (const state of ['config', 'assets', 'driver', 'modules', 'cache-generation']) {
		assert.throws(
			() => applyImage(replay.memory, image, { context: `changed-${state}` }),
			ImageMismatchError
		);
		emit({
			kind: 'safety',
			case: state,
			requiresCallerFingerprint: true,
			mismatchRefused: true
		});
	}
	emit({ kind: 'closed', complete: true });
	console.log('boot eligibility complete');
}
