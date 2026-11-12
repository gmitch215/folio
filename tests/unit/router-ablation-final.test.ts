import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import {
	combined,
	runWasm,
	sha256,
	type Driver
} from '../../scripts/research/final-cases/build-drivers.ts';
import {
	armOrder,
	certifyDriver,
	dryLines,
	FINAL_ARMS,
	guardFinal,
	loadFinal,
	measure,
	plannedCells,
	serialAgreement,
	wasmPathOf,
	type CellArgs
} from '../../scripts/research/final-cases/router-ablation-final.ts';
import { assemble } from '../../scripts/research/ownership-modules.ts';
import { guardManifest } from '../../scripts/research/router-ablation.ts';
import { CertificateCache, ROUTER_REASONS } from '../../src/router.ts';

const RECORDS = 12;
const SLOT = 32;
const memory = { initialPages: 2, maximumPages: 16 };

type Kind = 'window' | 'arena' | 'counter';

// 12 records of 16 input bytes, one 64-byte arena slice each; window keeps its scratch in static
// cells, arena writes through its slice, counter bumps a shared cell
const moduleOf = (kind: Kind) =>
	assemble(`(module
	(import "env" "memory" (memory 2 16))
	(global $hb (export "__heap_base") i32 (i32.const 8192))
	(func (export "prepare") (param $t i32) (param $n i32) (param $h i32) (result i32)
		(local $i i32) (local $j i32) (local $rec i32) (local $p i32) (local $arenas i32)
		(local.set $arenas (i32.add (local.get $h) (i32.and (i32.add (i32.shl (local.get $n) (i32.const 4)) (i32.const 63)) (i32.const -64))))
		(loop $each
			(local.set $rec (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4))))
			(local.set $p (i32.add (local.get $h) (i32.shl (local.get $i) (i32.const 4))))
			(i32.store (local.get $rec) (local.get $p))
			(i32.store offset=4 (local.get $rec) (i32.const 16))
			(i32.store offset=8 (local.get $rec) (i32.const 0))
			(i32.store offset=12 (local.get $rec) (i32.add (local.get $arenas) (i32.shl (local.get $i) (i32.const 6))))
			(local.set $j (i32.const 0))
			(loop $fill
				(i32.store8 (i32.add (local.get $p) (local.get $j))
					(i32.add (i32.mul (local.get $i) (i32.const 31)) (i32.add (i32.mul (local.get $j) (i32.const 7)) (i32.const 3))))
				(br_if $fill (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const 16))))
			(br_if $each (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
		(i32.shl (local.get $n) (i32.const 4)))
	(func (export "bulk") (param $t i32) (param $n i32) (param $o i32)
		(local $i i32) (local $k i32) (local $sum i32) (local $p i32) (local $arena i32) (local $slot i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $p (i32.load (local.get $t)))
			(local.set $arena (i32.load offset=12 (local.get $t)))
			(local.set $slot (i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 5))))
			(local.set $sum (i32.const 0))
			(local.set $k (i32.const 0))
			(loop $add
				(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
				(br_if $add (i32.lt_u (local.tee $k (i32.add (local.get $k) (i32.const 1))) (i32.const 16))))
			${
				kind === 'window'
					? `(i32.store (i32.const 4120) (local.get $sum))
			(i32.store (i32.const 4124) (i32.add (i32.load (i32.const 4120)) (i32.const 1)))
			(i32.store (local.get $slot) (i32.load (i32.const 4124)))
			(i32.store offset=4 (local.get $slot) (i32.mul (local.get $sum) (i32.const 31)))`
					: `(i32.store (local.get $arena) (local.get $sum))
			(i32.store offset=4 (local.get $arena) (i32.add (i32.mul (local.get $sum) (i32.const 31)) (i32.const 1)))
			(i32.store (local.get $slot) (i32.load (local.get $arena)))
			(i32.store offset=4 (local.get $slot) (i32.load offset=4 (local.get $arena)))`
			}
			${kind === 'counter' ? '(i32.store (i32.const 4096) (i32.add (i32.load (i32.const 4096)) (i32.const 1)))' : ''}
			(local.set $t (i32.add (local.get $t) (i32.const 16)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each))))
)`);

const bytes = {
	window: moduleOf('window'),
	arena: moduleOf('arena'),
	counter: moduleOf('counter')
};

const driverOf = (id: string, nativeSlotsSha256: string): Driver =>
	({
		id,
		function: 'bulk',
		category: 'fixture',
		define: 'FIXTURE',
		records: RECORDS,
		slot: SLOT,
		recordCapacity: 16,
		arena: 64,
		genArena: 64,
		arenaResetPerRecord: false,
		sourceFile: 'scripts/research/final-cases/drivers/fixture.c',
		result: { build: 'PASS', nativeSlotsSha256 }
	}) as Driver;

const world = () => {
	const dir = mkdtempSync(join(tmpdir(), 'router-final-adapter-'));
	const finalDir = join(dir, 'final-cases');
	const buildDir = join(dir, 'build');
	mkdirSync(join(finalDir, 'prereg'), { recursive: true });
	mkdirSync(join(finalDir, 'drivers'), { recursive: true });
	const manifestPath = join(finalDir, 'final-manifest.json');
	return { dir, finalDir, buildDir, manifestPath };
};

const fixture = async () => {
	const w = world();
	const drivers: Driver[] = [];
	for (const [name, module] of Object.entries(bytes)) {
		const id = `fixture-${name}`;
		mkdirSync(join(w.buildDir, id), { recursive: true });
		writeFileSync(wasmPathOf(w.buildDir, id), module);
		const probe = driverOf(id, '');
		const serial = await runWasm(wasmPathOf(w.buildDir, id), probe, 2, { memory } as never);
		assert.ok(serial.stable);
		drivers.push(driverOf(id, combined(serial.digests)));
	}
	const spare = driverOf('fixture-not-drawn', sha256('x'));
	writeFileSync(
		w.manifestPath,
		JSON.stringify({
			schema: 1,
			memory,
			projects: [{ id: 'fixture', drivers: [...drivers, spare] }]
		})
	);
	writeFileSync(
		join(w.finalDir, 'prereg', 'draw.json'),
		JSON.stringify({ drawn: drivers.map((d) => d.id) })
	);
	return { ...w, drivers };
};

const cell = (
	w: Awaited<ReturnType<typeof fixture>>,
	driver: Driver,
	arm: CellArgs['arm'],
	extra: Partial<CellArgs> = {}
): CellArgs => ({
	driver,
	arm,
	session: 1,
	round: 0,
	workers: 2,
	warm: 1,
	manifest: w.manifestPath,
	memory,
	buildDir: w.buildDir,
	final: true,
	finalDir: w.finalDir,
	floors: { windowFloorMs: 0, trackedFloorMs: 0 },
	...extra
});

describe('guard and loader', () => {
	test('a run needs --final and the freeze file, and the loader reads only the drawn drivers', async () => {
		const w = await fixture();
		assert.throws(() => guardFinal(w.manifestPath, { finalDir: w.finalDir }), /pass --final/);
		assert.throws(
			() => loadFinal(w.manifestPath, { finalDir: w.finalDir, final: true }),
			/FROZEN/
		);
		writeFileSync(join(w.finalDir, 'prereg', 'FROZEN'), 'frozen\n');
		const loaded = loadFinal(w.manifestPath, { finalDir: w.finalDir, final: true });
		assert.deepEqual(
			loaded.drivers.map((d) => d.id),
			['fixture-window', 'fixture-arena', 'fixture-counter']
		);
		assert.deepEqual(loaded.memory, memory);
		writeFileSync(
			join(w.finalDir, 'prereg', 'draw.json'),
			JSON.stringify({ drawn: ['fixture-window', 'fixture-missing'] })
		);
		assert.throws(
			() => loadFinal(w.manifestPath, { finalDir: w.finalDir, final: true }),
			/not in the manifest/
		);
	});

	test('a manifest outside the final directory still needs --final, and a driver path is only resolved', async () => {
		const w = await fixture();
		writeFileSync(join(w.finalDir, 'prereg', 'FROZEN'), 'frozen\n');
		const copy = join(w.dir, 'copy.json');
		writeFileSync(copy, '{}');
		assert.doesNotThrow(() => guardManifest(copy, { finalDir: w.finalDir }));
		assert.throws(() => guardFinal(copy, { finalDir: w.finalDir }), /--final/);
		const source = join(w.finalDir, 'drivers', 'cjson-parse.c');
		writeFileSync(source, '');
		assert.throws(() => guardManifest(source, { finalDir: w.finalDir }), /pass --final/);
		assert.doesNotThrow(() => guardManifest(source, { finalDir: w.finalDir, final: true }));
		assert.equal(
			wasmPathOf('/b', 'cjson-cJSON_ParseWithLength'),
			'/b/cjson-cJSON_ParseWithLength/driver.wasm'
		);
		assert.throws(() => wasmPathOf('/b', '../x'), /bad driver id/);
		assert.throws(() => wasmPathOf('/b', 'a/b'), /bad driver id/);
	});
});

describe('dry listing', () => {
	test('lists the cells and the arm order without reading a module', () => {
		const ids = ['a', 'b', 'c'];
		const lines = dryLines(ids, [...FINAL_ARMS], 2);
		assert.match(lines[0]!, /^cells 36 \(3 drivers, 6 arms, 2 rounds\) order rotation$/);
		assert.equal(lines.length, 1 + 6);
		assert.equal(lines[1], '0\t0\ta\tserial,w1,w2,independent,shared,router');
		assert.equal(lines[2], '0\t1\tb\tw1,w2,independent,shared,router,serial');
		assert.equal(lines[4], '1\t0\ta\tw1,w2,independent,shared,router,serial');
		const seeded = plannedCells(ids, [...FINAL_ARMS], 2, 12345);
		assert.deepEqual(seeded, plannedCells(ids, [...FINAL_ARMS], 2, 12345));
		assert.notDeepEqual(seeded, plannedCells(ids, [...FINAL_ARMS], 2, 12346));
		for (const c of seeded) assert.deepEqual([...c.arms].sort(), [...FINAL_ARMS].sort());
		assert.deepEqual(armOrder([...FINAL_ARMS], 3, 2), [
			...FINAL_ARMS.slice(5),
			...FINAL_ARMS.slice(0, 5)
		]);
	});

	test('the six final arms are the prereg arms and not the development one', () => {
		assert.deepEqual(
			[...FINAL_ARMS],
			['serial', 'w1', 'w2', 'independent', 'shared', 'router']
		);
	});
});

describe('one cell on the fixture module', () => {
	test('every arm gives the serial slots and the frozen checksum', async () => {
		const w = await fixture();
		writeFileSync(join(w.finalDir, 'prereg', 'FROZEN'), 'frozen\n');
		for (const driver of w.drivers.slice(0, 2)) {
			const rows: Awaited<ReturnType<typeof measure>>[] = [];
			for (const arm of FINAL_ARMS) rows.push(await measure(cell(w, driver, arm)));
			for (const row of rows) {
				assert.equal(row.passed, true, `${driver.id} ${row.arm} ${row.route}`);
				assert.equal(row.digest, driver.result!.nativeSlotsSha256);
				assert.ok(
					ROUTER_REASONS.includes(row.reason as never) || row.reason === 'baseline'
				);
				assert.ok((row.wallMs as number) > 0);
				assert.equal((row.load as number[]).length, 2);
				assert.ok((row.resourceUsage as { maxRSS: number }).maxRSS > 0);
				assert.ok((row.memoryUsage as { rss: number }).rss > 0);
				assert.equal(row.session, 1);
			}
			assert.equal(rows[0]!.route, 'serial');
			assert.equal(rows[0]!.reason, 'baseline');
			assert.deepEqual(serialAgreement(rows as never), []);
			const folio = rows.slice(1);
			assert.ok(folio.every((r) => (r.decision as { route: string }).route !== undefined));
			if (driver.id === 'fixture-window')
				for (const arm of ['w2', 'independent', 'shared', 'router']) {
					const row = rows.find((r) => r.arm === arm)!;
					assert.equal(row.route, 'window', arm);
					assert.equal(row.certificate, 'window', arm);
					assert.equal(row.dispatched, true, arm);
				}
		}
	});

	test('a refused certificate runs serial with the typed reason and the same bytes', async () => {
		const w = await fixture();
		writeFileSync(join(w.finalDir, 'prereg', 'FROZEN'), 'frozen\n');
		const driver = w.drivers[2]!;
		for (const arm of ['w2', 'independent', 'shared', 'router'] as const) {
			const row = await measure(cell(w, driver, arm));
			assert.equal(row.route, 'serial', arm);
			assert.equal(row.reason, 'shared-state', arm);
			assert.equal(row.certificate, 'none');
			assert.equal(row.refusal, 'shared-state');
			assert.equal(row.passed, true);
			assert.equal(row.dispatched, false);
		}
	});

	test('a wrong output is reported with its slot digests and a serial mismatch is found', async () => {
		const w = await fixture();
		writeFileSync(join(w.finalDir, 'prereg', 'FROZEN'), 'frozen\n');
		const wrong = driverOf('fixture-window', sha256('not the checksum'));
		const row = await measure(cell(w, wrong, 'serial'));
		assert.equal(row.passed, false);
		assert.equal((row.slots as string[]).length, RECORDS);
		const make = (arm: string, digest: string) =>
			({
				kind: 'sample',
				driver: 'd',
				arm,
				round: 0,
				wallMs: 1,
				passed: true,
				digest
			}) as never;
		assert.deepEqual(serialAgreement([make('serial', 'x'), make('router', 'x')]), []);
		assert.deepEqual(serialAgreement([make('serial', 'x'), make('router', 'y')]), [
			{ driver: 'd', arm: 'router', round: 0 }
		]);
	});

	test('the adapter refuses a cell when the freeze file is missing', async () => {
		const w = await fixture();
		await assert.rejects(measure(cell(w, w.drivers[0]!, 'serial')), /FROZEN/);
		await assert.rejects(measure(cell(w, w.drivers[0]!, 'today' as never)), /not a final arm/);
	});
});

describe('certify', () => {
	test('certificates and refusals are tabulated and the cache is keyed by the module hash', async () => {
		const w = await fixture();
		const cache = new CertificateCache();
		const rows = [
			...certifyDriver(bytes.window, w.drivers[0]!, memory, cache, 1),
			...certifyDriver(bytes.counter, w.drivers[2]!, memory, cache, 1)
		];
		const of = (driver: string, mode: string) =>
			rows.find((r) => r.driver === driver && r.mode === mode && !r.persistent)!;
		assert.equal(of('fixture-window', 'independent').certificate, 'window');
		assert.equal(of('fixture-counter', 'independent').refusal, 'shared-state');
		assert.equal(of('fixture-counter', 'shared').refusal, 'shared-state');
		assert.notEqual(
			of('fixture-window', 'independent').moduleSha256,
			of('fixture-counter', 'independent').moduleSha256
		);
		const persistent = rows.filter((r) => r.persistent);
		assert.deepEqual(
			persistent.map((r) => r.cacheHit),
			[false, false]
		);
		const again = certifyDriver(bytes.window, w.drivers[0]!, memory, cache, 0);
		assert.equal(again[0]!.cacheHit, true);
		assert.equal(again[0]!.certifyMs, 0);
		const copy = new CertificateCache();
		copy.load(cache.serialize());
		assert.equal(
			certifyDriver(bytes.counter, w.drivers[1]!, memory, copy, 0)[0]!.cacheHit,
			true
		);
	});
});
