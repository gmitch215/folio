import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assemble } from '../../scripts/research/ownership-modules.ts';
import { cases, MODES } from '../../scripts/research/ownership-redteam-router.ts';
import type { Row } from '../../scripts/research/ownership-redteam-run.ts';
import { build, exotic, plan, wat } from '../../scripts/research/ownership-redteam.ts';
import { certifyOwnership, OWNERSHIP_REASONS } from '../../src/ownership.ts';

describe('the ownership red-team generator', () => {
	test('a seed gives the same module', () => {
		assert.equal(wat(plan(17)), wat(plan(17)));
		assert.notEqual(wat(plan(17)), wat(plan(18)));
	});

	test('the shared memory form differs only in the memory import', () => {
		assert.equal(wat(plan(17), true).replace(' shared', ''), wat(plan(17)));
		assert.ok(build(plan(17), true).length > 0);
	});

	test('the plans cover every skeleton, mode and attack', () => {
		const skeletons = new Set<string>();
		const modes = new Set<string>();
		const attacks = new Set<string>();
		for (let seed = 1; seed <= 1500; seed++) {
			const p = plan(seed);
			skeletons.add(p.skeleton);
			modes.add(p.mode);
			p.attacks.forEach((a) => attacks.add(a));
		}
		assert.equal(skeletons.size, 5);
		assert.equal(modes.size, 3);
		for (const name of [
			'first-flag',
			'index-data',
			'addr-byte',
			'indirect',
			'loop-stale',
			'bulk-partial',
			'exotic',
			'global',
			'sp-leak',
			'trap-late',
			'base-param',
			'memsize',
			'cond-write',
			'partial-width',
			'return-early',
			'break-data',
			'tee-carry',
			'const-store',
			'f64-carry',
			'copy-overlap'
		])
			assert.ok(attacks.has(name), name);
	});

	test('generated modules assemble and the checker answers with a certificate or a listed reason', () => {
		let certificates = 0;
		for (let seed = 1; seed <= 80; seed++) {
			const result = certifyOwnership(build(plan(seed)));
			if (result.kind === 'certificate') certificates++;
			else assert.ok(OWNERSHIP_REASONS.includes(result.reason), result.reason);
		}
		assert.ok(certificates >= 8, `certificates ${certificates}`);
	});

	test('the router case list covers every mode and every call variant', () => {
		const rows: Row[] = [];
		for (let seed = 1; seed <= 400; seed++) {
			const outcome =
				seed % 3 === 0 ? 'no-window' : seed % 3 === 1 ? 'certificate' : 'isolation';
			rows.push({
				seed,
				skeleton: 'indexed',
				attacks: [],
				outcome,
				verdict: outcome === 'certificate' ? (seed % 7 === 1 ? 'false' : 'ok') : undefined
			});
		}
		const list = cases(rows);
		assert.ok(list.length >= 500, `cases ${list.length}`);
		assert.deepEqual(new Set(list.map((c) => c.mode)), new Set(MODES));
		assert.deepEqual(
			new Set(list.map((c) => c.variant)),
			new Set([
				'standard',
				'writes-empty',
				'writes-arena',
				'writes-out',
				'writes-shifted',
				'regions-shifted',
				'shared-memory',
				'overlap-window',
				'overlap-regions'
			])
		);
		assert.deepEqual(list, cases(rows));
	});

	test('the exotic address chain evaluates to the value the generator claims', () => {
		let state = 12345;
		const next = () => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			return state / 4294967296;
		};
		for (let n = 0; n < 40; n++) {
			const target = 4096 + 4 * Math.floor(next() * 30);
			const x = exotic(next, target, 1 + Math.floor(next() * 6));
			const bytes = assemble(`(module (func (export "f") (result i32) ${x.wat}))`);
			const f = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
				.f as () => number;
			assert.equal(f(), target, x.wat);
		}
	});
});
