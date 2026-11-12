import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import {
	ARENA,
	assemble,
	BASES,
	DATA,
	iterModuleOf,
	iterWat,
	layoutRecords,
	OUT,
	RECORDS,
	SYNTHETIC,
	TABLE
} from '../../scripts/research/ownership-modules.ts';
import {
	mutantModule,
	PREFIX_BASES,
	PREFIX_MUTANTS,
	prefixModuleOf
} from '../../scripts/research/ownership-prefix-modules.ts';
import {
	FINAL_DIR,
	firstDifference,
	guardManifest,
	loadManifest,
	summarize,
	type Sample
} from '../../scripts/research/router-ablation.ts';
import { certifyOwnership } from '../../src/ownership.ts';
import {
	CertificateCache,
	decide,
	lowerEstimate,
	Router,
	ROUTER_REASONS,
	type RecordsCall,
	type RouterMode,
	type RouterOptions,
	type RouterReason,
	type StreamCall
} from '../../src/router.ts';

const MAX = 40;
const regions: [number, number][] = [
	[TABLE, TABLE + 16 * RECORDS],
	[DATA, DATA + 320 * RECORDS],
	[OUT, OUT + 64 * RECORDS],
	[ARENA, ARENA + 64 * RECORDS]
];
const writes: [number, number][] = [[OUT, OUT + 64 * RECORDS]];
const records = (extra: Partial<RecordsCall> = {}): RecordsCall => ({
	kind: 'records',
	entry: 'bulk',
	count: RECORDS,
	args: (from, to) => [TABLE + 16 * from, to - from, OUT + 64 * from],
	regions,
	writes,
	...extra
});

const window = iterModuleOf(BASES.scratch!, undefined, MAX);
const clean = assemble(iterWat({ body: SYNTHETIC.clean!, max: MAX }));
const counter = assemble(iterWat({ body: SYNTHETIC.counter!, max: MAX }));
const cursor = iterModuleOf(BASES.scratch!, 'cursor-store', MAX);
const imported = iterModuleOf(BASES.scratch!, 'import-plain', MAX);
const prefixed = prefixModuleOf(PREFIX_BASES.sha!);
const wild = iterModuleOf(BASES.fill!, 'wide-dynamic-store', MAX);

const STREAM_WAT = (mix: string) => `(module
	(memory (export "memory") 32 64)
	(func (export "poly") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $s ${mix})
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $s)))`;
const byte = '(i32.load8_u (i32.add (local.get $p) (local.get $i)))';
const poly = assemble(STREAM_WAT(`(i32.add (i32.mul (local.get $s) (i32.const 31)) ${byte})`));
const square = assemble(STREAM_WAT(`(i32.add (i32.mul (local.get $s) (local.get $s)) ${byte})`));
const stream: StreamCall = { kind: 'stream', entry: 'poly', ptr: 65536, len: 100000 };

const options = (mode: RouterMode, extra: Partial<RouterOptions> = {}): RouterOptions => ({
	mode,
	pages: 8,
	workers: 2,
	...extra
});
const assume = { importsDeterministic: true, residueUnobserved: true };

const fill = (memory: WebAssembly.Memory, seed: number) => {
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
};

function serialBytes(bytes: Uint8Array, seed: number) {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: MAX });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory }
	});
	fill(memory, seed);
	(instance.exports.bulk as (...a: number[]) => void)(TABLE, RECORDS, OUT);
	return new Uint8Array(memory.buffer).slice(OUT, OUT + 64 * RECORDS);
}

describe('route order and refusal reasons', () => {
	const route = (bytes: Uint8Array, mode: RouterMode, extra: Partial<RouterOptions> = {}) =>
		decide(bytes, records(), options(mode, extra)).decision;

	test('a certified window beats the tracked route, a stream takes the summary', () => {
		const first = route(window, 'router', { assume });
		assert.equal(first.route, 'window');
		assert.equal(first.reason, 'certified-window');
		const summary = decide(poly, stream, options('router')).decision;
		assert.equal(summary.route, 'summary');
		assert.equal(summary.reason, 'certified-summary');
	});

	test('every refusal names its reason from the closed list', () => {
		const cases: [string, RouterReason, Uint8Array, RouterMode, Partial<RouterOptions>?][] = [
			['mode-serial', 'mode-serial', window, 'serial'],
			['single-worker', 'single-worker', window, 'router', { workers: 1 }],
			['mode has no records route', 'no-route-in-mode', window, 'w1'],
			['no certificate in the w2 mode', 'no-certificate', clean, 'w2'],
			['unasserted assumptions', 'assumption-unasserted', clean, 'router'],
			['allocator state', 'allocator-state', cursor, 'w2'],
			['shared static state', 'shared-state', counter, 'router', { assume }],
			['an import', 'unclassified-dependency', imported, 'router', { assume }],
			['a wild store', 'wild-store', wild, 'w2']
		];
		for (const [name, reason, bytes, mode, extra] of cases) {
			const got = route(bytes, mode, extra);
			assert.equal(got.route, 'serial', name);
			assert.equal(got.reason, reason, `${name}: ${got.detail}`);
			assert.ok(ROUTER_REASONS.includes(got.reason));
		}
		const overlap = decide(
			window,
			records({ regions: [...regions, [4100, 4104]] }),
			options('router', { assume })
		).decision;
		assert.equal(overlap.reason, 'layout-overlap');
		const wrongCall = decide(poly, stream, options('w2')).decision;
		assert.equal(wrongCall.reason, 'no-route-in-mode');
		const refused = decide(square, stream, options('w1')).decision;
		assert.equal(refused.reason, 'stream-refused');
		assert.equal(decide(window, stream, options('shared')).decision.reason, 'not-a-stream');
		assert.equal(
			decide(poly, records({ entry: 'poly' }), options('shared')).decision.reason,
			'memory-not-imported'
		);
	});

	test('the tracked route runs only where the certifier found no shared state and the caller asserts', () => {
		const taken = route(clean, 'router', { assume });
		assert.equal(taken.route, 'tracked');
		assert.equal(taken.reason, 'tracked-eligible');
		assert.equal(
			route(clean, 'router', { assume: { residueUnobserved: true } }).route,
			'tracked'
		);
		assert.equal(
			route(clean, 'router', { assume: { importsDeterministic: true } }).reason,
			'assumption-unasserted'
		);
		const explicit = route(clean, 'router', { assume, explicit: async () => {} });
		assert.equal(explicit.route, 'explicit');
	});

	test('an allocator driver takes the tracked route only on the caller assertions', () => {
		const taken = route(cursor, 'router', { assume });
		assert.equal(taken.route, 'tracked');
		assert.equal(taken.reason, 'tracked-eligible');
		assert.equal(route(cursor, 'router').reason, 'assumption-unasserted');
		assert.equal(route(cursor, 'w2').reason, 'allocator-state');
		assert.equal(route(counter, 'router', { assume }).reason, 'shared-state');
	});

	test('a buffer filled up to a cursor takes the window route through the prefix option', () => {
		const sha = records({ entry: 'bulk' });
		const got = decide(prefixed, sha, options('w2')).decision;
		assert.equal(got.route, 'window');
		assert.equal(got.reason, 'certified-window');
		assert.equal(certifyOwnership(prefixed, { entry: 'bulk' }).kind, 'refusal');
		for (const name of [
			'cursor-plus-two',
			'skip-a-byte',
			'conditional-byte',
			'reset-above-prefix'
		]) {
			const bytes = mutantModule(PREFIX_MUTANTS.find((m) => m.name === name)!);
			const refused = decide(bytes, sha, options('w2')).decision;
			assert.equal(refused.route, 'serial', name);
			assert.equal(refused.reason, 'shared-state', `${name}: ${refused.detail}`);
		}
	});
});

describe('serial estimate', () => {
	test('a tracked call lowers the per-record estimate to its own plain first iteration, never raises it', () => {
		assert.equal(lowerEstimate(0.5, 0.04), 0.04);
		assert.equal(lowerEstimate(0.5, 0.9), 0.5);
		assert.equal(lowerEstimate(0.5, undefined), 0.5);
		assert.equal(lowerEstimate(0.5, 0), 0.5);
		assert.equal(lowerEstimate(0.5, Number.NaN), 0.5);
	});
});

describe('certificate cache', () => {
	test('the second decision costs a lookup, for a certificate and for a refusal', () => {
		const cache = new CertificateCache();
		for (const [bytes, reason] of [
			[window, 'certified-window'],
			[cursor, 'allocator-state']
		] as const) {
			const first = decide(bytes, records(), options('w2', { cache })).decision;
			assert.equal(first.cacheHit, false);
			assert.ok(first.certifyMs > 0);
			const again = decide(bytes, records(), options('w2', { cache })).decision;
			assert.equal(again.cacheHit, true);
			assert.equal(again.certifyMs, 0);
			assert.equal(again.reason, reason);
		}
		assert.equal(cache.hits, 2);
		assert.equal(cache.misses, 2);
	});

	test('a changed module, backend or configuration is a miss', () => {
		const cache = new CertificateCache();
		const miss = (bytes: Uint8Array, c: CertificateCache, extra: Partial<RouterOptions> = {}) =>
			decide(bytes, records(), options('w2', { cache: c, ...extra })).decision.cacheHit ===
			false;
		assert.ok(miss(window, cache));
		assert.ok(!miss(window, cache));
		assert.ok(miss(iterModuleOf(BASES.scratch!, undefined, MAX + 1), cache));
		assert.ok(miss(window, cache, { ownership: { maxSteps: 3_999_999 } }));
		assert.ok(miss(window, cache, { ownership: { prefix: { cell: 4160, base: 4096 } } }));
		assert.ok(miss(window, new CertificateCache({ backend: 'another-engine' })));
		const copy = new CertificateCache({ backend: 'another-engine' });
		copy.load(cache.serialize());
		assert.ok(miss(window, copy));
		const same = new CertificateCache();
		same.load(cache.serialize());
		assert.ok(!miss(window, same));
	});

	test('the entry is part of the configuration', () => {
		const cache = new CertificateCache();
		decide(window, records(), options('w2', { cache }));
		const other = decide(window, records({ entry: 'missing' }), options('w2', { cache }));
		assert.equal(other.decision.cacheHit, false);
	});
});

describe('shared and independent analyses', () => {
	test('on a module both builders can certify they give the same routes and certificates', () => {
		for (const [bytes, call] of [
			[window, records()],
			[poly, stream],
			[clean, records()],
			[square, stream]
		] as const) {
			const a = decide(bytes, call, options('independent', { assume }));
			const b = decide(bytes, call, options('shared', { assume }));
			assert.equal(a.decision.route, b.decision.route);
			assert.equal(a.decision.reason, b.decision.reason);
			assert.deepEqual(a.window, b.window);
			assert.deepEqual(a.stream, b.stream);
			assert.ok(b.decision.analyses.includes('shape'));
			assert.ok(!a.decision.analyses.includes('shape'));
		}
	});
});

describe('running a route', () => {
	test('a program that imports its memory shared runs on the serial route, an unshared one still does', async () => {
		const text = iterWat({ body: BASES.scratch!.join('\n'), max: MAX });
		const sharedProgram = assemble(text.replace('(memory 8 40)', '(memory 8 40 shared)'));
		const want = serialBytes(window, 3);
		for (const [name, bytes, mode] of [
			['shared', sharedProgram, 'serial'],
			['shared', sharedProgram, 'w2'],
			['unshared', window, 'serial']
		] as const) {
			const router = await Router.open(bytes, records(), { ...options(mode), maxPages: MAX });
			try {
				assert.equal(router.decision.route, 'serial', `${name} ${mode}`);
				fill(router.memory, 3);
				await router.run();
				assert.deepEqual(
					new Uint8Array(router.memory.buffer).slice(OUT, OUT + 64 * RECORDS),
					want,
					`${name} ${mode}`
				);
			} finally {
				await router.close();
			}
		}
	});

	test('the window route leaves the serial bytes, and a loop under the floor stays serial', async () => {
		const forced = await Router.open(window, records(), {
			...options('w2'),
			maxPages: MAX,
			floors: { windowFloorMs: 0 }
		});
		const small = await Router.open(window, records(), { ...options('w2'), maxPages: MAX });
		try {
			assert.equal(forced.decision.route, 'window');
			for (const router of [forced, small]) fill(router.memory, 3);
			const run = await forced.run();
			assert.equal(run.route, 'window');
			assert.ok(run.probeMs! >= 0);
			const slot = (r: Router) =>
				new Uint8Array(r.memory.buffer).slice(OUT, OUT + 64 * RECORDS);
			assert.deepEqual(slot(forced), serialBytes(window, 3));
			// dispatches after the first are judged against the serial estimate, and two losses in a
			// row end the dispatch: tiny records lose and stay serial
			assert.equal((await forced.run()).route, 'window');
			assert.equal((await forced.run()).route, 'window');
			const lost = await forced.run();
			assert.equal(lost.route, 'serial');
			assert.equal(lost.reason, 'dispatch-lost');
			assert.deepEqual(slot(forced), serialBytes(window, 3));
			const refused = await small.run();
			assert.equal(refused.route, 'serial');
			assert.equal(refused.reason, 'below-floor');
			assert.deepEqual(slot(small), serialBytes(window, 3));
		} finally {
			await forced.close();
			await small.close();
		}
	});

	test('the summary route folds the stream and equals the serial call', async () => {
		const router = await Router.open(poly, stream, {
			...options('w1', { pages: 40 }),
			floors: { summaryMinBytes: 0 }
		});
		const serial = await Router.open(poly, stream, options('serial', { pages: 40 }));
		try {
			assert.equal(router.decision.route, 'summary');
			for (const r of [router, serial]) {
				const view = new Uint8Array(r.memory.buffer, stream.ptr, stream.len);
				for (let i = 0; i < view.length; i++)
					view[i] = (Math.imul(i, 2654435761) >>> 24) & 255;
			}
			const folded = await router.run({ initial: 7n });
			const plain = await serial.run({ initial: 7n });
			assert.equal(folded.route, 'summary');
			assert.equal(plain.route, 'serial');
			assert.equal(folded.state, plain.state);
		} finally {
			await router.close();
			await serial.close();
		}
	});
});

describe('ablation harness', () => {
	const fixture = () => {
		const dir = mkdtempSync(join(tmpdir(), 'router-final-'));
		mkdirSync(join(dir, 'final-cases', 'prereg'), { recursive: true });
		const manifest = join(dir, 'final-cases', 'final-manifest.json');
		writeFileSync(
			manifest,
			JSON.stringify({
				schema: 1,
				projects: [
					{
						id: 'fixture',
						drivers: [
							{ id: 'fixture-a', records: 64, slot: 256 },
							{ id: 'fixture-b', records: 128, slot: 512 }
						]
					}
				]
			})
		);
		return { finalDir: join(dir, 'final-cases'), manifest };
	};

	test('a manifest under the final corpus needs --final and the freeze file', () => {
		assert.throws(() => guardManifest(join(FINAL_DIR, 'final-manifest.json')), /pass --final/);
		const { finalDir, manifest } = fixture();
		assert.throws(() => loadManifest(manifest, { finalDir }), /pass --final/);
		assert.throws(() => loadManifest(manifest, { finalDir, final: true }), /FROZEN/);
		writeFileSync(join(finalDir, 'prereg', 'FROZEN'), '');
		const entries = loadManifest(manifest, { finalDir, final: true });
		assert.deepEqual(
			entries.map((e) => [e.id, e.kind, e.records, e.slot]),
			[
				['fixture-a', 'final', 64, 256],
				['fixture-b', 'final', 128, 512]
			]
		);
	});

	test('the development manifests load', () => {
		const probe = loadManifest('results/execution/footprint/probe.json');
		assert.equal(new Set(probe.map((e) => e.id)).size, probe.length);
		assert.ok(probe.some((e) => e.id === 'aes-cbc-decrypt-shared'));
		const corpus = loadManifest('scripts/research/corpus-manifest.json');
		assert.ok(corpus.length > 0 && corpus.every((e) => e.kind === 'c21'));
		assert.throws(() => loadManifest('package.json'), /not a driver manifest/);
	});

	test('a route that changes one byte is reported as a wrong output', () => {
		const want = Uint8Array.from({ length: 64 }, (_, i) => i);
		const fake = Uint8Array.from(want);
		assert.equal(firstDifference(want, fake), -1);
		fake[37] = fake[37]! ^ 1;
		assert.equal(firstDifference(want, fake), 37);
		const row = (arm: Sample['arm'], round: number, wallMs: number, passed = true): Sample => ({
			kind: 'sample',
			driver: 'd',
			arm,
			round,
			wallMs,
			passed
		});
		const samples = [
			row('serial', 0, 10),
			row('serial', 1, 12),
			row('router', 0, 5),
			row('router', 1, 6, false)
		];
		const result = summarize(samples, ['router']);
		assert.equal(result.wrong.length, 1);
		assert.equal(result.rows.router![0]!.wrong, 1);
		assert.ok(Math.abs(result.rows.router![0]!.speedup.median - 2) < 1e-9);
	});
});
