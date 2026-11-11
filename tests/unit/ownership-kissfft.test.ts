import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	configImage,
	KCFG,
	KEXTENT,
	KFACTORS,
	KISS_MUTANTS,
	KISS_RUN,
	KISS_WORK,
	kissCase,
	kissModule,
	kissMutantModule,
	kissOptions,
	kissRoute,
	recordsOwn,
	staleModule,
	valsModule
} from '../../scripts/research/ownership-kissfft-modules.ts';
import {
	certifyOwnership,
	checkConfig,
	guardRecords,
	OWNERSHIP_REASONS,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipOptions,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const SEEDS = [1, 2, 3];
const TABLE = 8192;

const certificate = (bytes: Uint8Array, options: OwnershipOptions = kissOptions()) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const refused = (bytes: Uint8Array, options: OwnershipOptions = kissOptions()) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	assert.ok(OWNERSHIP_REASONS.includes((r as OwnershipRefusal).reason));
	return r as OwnershipRefusal;
};

const mutant = (name: string) => KISS_MUTANTS.find((m) => m.name === name)!;
const refusedMutant = (name: string) =>
	refused(kissMutantModule(mutant(name)), kissOptions(mutant(name).factors));

describe('config premise and bounded recursion', () => {
	test('a recursive butterfly over a scratch buffer from a table word certifies and matches the route', () => {
		const bytes = kissModule();
		const c = certificate(bytes);
		assert.deepEqual(c.windows, [{ low: 49344, end: 49408 }]);
		assert.deepEqual(c.written, [[49352, 49384]]);
		assert.equal(c.wildStores, 0);
		assert.deepEqual(c.recursion, { cap: 12, depth: 3 });
		assert.equal(c.config?.at, KCFG);
		assert.equal(c.config?.bytes, Buffer.from(configImage()).toString('hex'));
		assert.ok(verifyOwnership(bytes, c));
		assert.equal(kissRoute(bytes, c.windows, SEEDS), 'equal');
	});

	test('without the options the module is refused as before', () => {
		const bytes = kissModule();
		const plain = certifyOwnership(bytes);
		assert.equal(plain.kind, 'refusal');
		assert.match((plain as OwnershipRefusal).detail, /^recursion through/);
		refused(bytes, { recursion: 12 });
		const noRecursion = refused(bytes, { config: kissOptions().config });
		assert.match(noRecursion.detail, /^recursion through/);
	});

	test('the recursion cap is a refusal, never a truncated analysis', () => {
		const bytes = kissModule();
		const shallow = refused(bytes, kissOptions(KFACTORS, 2));
		assert.equal(shallow.reason, 'unsupported');
		assert.match(shallow.detail, /deeper than 2/);
		assert.equal(certificate(bytes, kissOptions(KFACTORS, 3)).recursion?.depth, 3);
		assert.equal(refusedMutant('recursion-without-exit').reason, 'unsupported');
	});

	test('a factor list that does not tile the scratch buffer is refused', () => {
		for (const name of ['two-pairs-short', 'leaf-of-one'])
			assert.equal(refusedMutant(name).reason, 'read-before-write', name);
		const four = mutant('leaf-of-four');
		const bytes = kissMutantModule(four);
		assert.equal(
			kissRoute(
				bytes,
				certificate(bytes, kissOptions(four.factors)).windows,
				SEEDS,
				four.factors
			),
			'equal'
		);
	});

	test('a read of the scratch buffer before its write is refused', () => {
		assert.equal(refusedMutant('scratch-read-before-write').reason, 'read-before-write');
	});

	test('a store that can reach the frozen words is refused, whatever its address', () => {
		for (const name of [
			'store-into-config',
			'store-reaches-config',
			'fill-over-config',
			'fill-through-data',
			'base-from-record-data'
		])
			assert.equal(refusedMutant(name).reason, 'config-store', name);
		const overlap = refused(kissModule(), {
			...kissOptions(),
			proposed: [{ low: KCFG, end: KCFG + 64 }]
		});
		assert.equal(overlap.reason, 'config-store');
		assert.ok(OWNERSHIP_REASONS.includes('config-store'));
	});

	test('the scratch pointer must not escape, and no trap may follow a write', () => {
		assert.equal(refusedMutant('pointer-escapes').reason, 'escape');
		assert.equal(refusedMutant('trap-after-write').reason, 'failure');
	});

	test('a store outside the window is counted as wild or opens its own window, and matches the route', () => {
		const m = mutant('store-past-window');
		const bytes = kissMutantModule(m);
		const c = certificate(bytes);
		assert.ok(c.windows.length > 1 || c.wildStores > 0);
		assert.equal(kissRoute(bytes, c.windows, SEEDS), 'equal');
	});

	test('sound variants certify and match the route', () => {
		for (const name of [
			'store-in-padding-before-read',
			'extra-output-word',
			'input-from-slot',
			'input-aliases-scratch-branch'
		]) {
			const bytes = kissMutantModule(mutant(name));
			assert.equal(kissRoute(bytes, certificate(bytes).windows, SEEDS), 'equal', name);
		}
	});

	test('the router premise: the frozen words and every table word', () => {
		const c = certificate(kissModule());
		const ok = kissCase(1).image;
		const table = { at: TABLE, count: 8 };
		assert.ok(checkConfig(c, ok, table));
		const factor = ok.slice();
		new Uint32Array(factor.buffer)[(KCFG + 8) / 4] = 3;
		assert.ok(!checkConfig(c, factor, table));
		const pointer = ok.slice();
		new Uint32Array(pointer.buffer)[KCFG / 4] = KCFG;
		assert.ok(!checkConfig(c, pointer, table));
		const aux = ok.slice();
		new Uint32Array(aux.buffer)[(TABLE + 16 * 5 + 8) / 4] = KCFG + 4;
		assert.ok(!checkConfig(c, aux, table));
		assert.ok(!checkConfig(c, ok.subarray(0, KCFG + 8), table));
		assert.ok(checkConfig({ ...c, config: undefined }, aux, table));
	});

	test('a record pointer indexed below its slot is accepted and breaks the listed premise, not the domain', () => {
		const imports = { f: () => {} };
		const cases = [1, 2, 3].map((seed) => kissCase(seed));
		const own = (bytes: Uint8Array) =>
			recordsOwn(bytes, certificate(bytes).windows, cases, 320, imports);
		assert.deepEqual(own(kissModule()), { ok: true });
		const below = kissModule(
			KISS_WORK,
			KISS_RUN.replace(
				'(i32.store offset=40 (local.get $slot)',
				'(i32.store (i32.sub (local.get $slot) (i32.const 8)) (i32.const 7))\n\t\t(i32.store offset=40 (local.get $slot)'
			)
		);
		assert.equal(own(below).ok, false);
	});

	test('the layout guard knows the config region', () => {
		const c = certificate(kissModule());
		assert.ok(guardRecords(c, [[16384, 20000]]));
		assert.ok(!guardRecords(c, [[KCFG + KEXTENT - 4, KCFG + KEXTENT + 4]]));
		assert.ok(!guardRecords(c, [[KCFG - 4, KCFG + 4]]));
		assert.ok(guardRecords(c, [[KCFG + KEXTENT, KCFG + KEXTENT + 64]]));
	});

	test('frames of one recursive function do not share relations or expression values', () => {
		const stale = refused(staleModule(), { recursion: 3 });
		assert.equal(stale.reason, 'read-before-write');
		assert.equal(stale.address, 4202);
		const vals = refused(valsModule(), { recursion: 3 });
		assert.equal(vals.reason, 'read-before-write');
		assert.equal(vals.address, 4203);
	});
});
