import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	build3,
	FRAMES,
	hashes,
	INSERTS,
	plan3,
	STRIDE_O,
	STRIDE_T,
	stripStride,
	summarize,
	wat3,
	type Row3
} from '../../scripts/research/ownership-redteam-3.ts';
import { certifyOwnership, OWNERSHIP_REASONS } from '../../src/ownership.ts';

describe('the round 3 ownership red-team generator', () => {
	test('a seed gives the same module', () => {
		assert.equal(wat3(plan3(17)), wat3(plan3(17)));
		assert.notEqual(wat3(plan3(17)), wat3(plan3(18)));
	});

	test('the plans cover every frame, every insert and every mode', () => {
		const frames = new Set<string>();
		const inserts = new Set<string>();
		const modes = new Set<string>();
		let odd = 0;
		for (let seed = 1; seed <= 4000; seed++) {
			const p = plan3(seed);
			frames.add(p.frame);
			modes.add(p.mode);
			p.inserts.forEach((i) => inserts.add(i));
			if (p.strideOdd) odd++;
			if (p.mode === 'safe') assert.deepEqual(p.inserts, []);
		}
		assert.deepEqual(frames, new Set(FRAMES.map(([f]) => f)));
		assert.deepEqual(modes, new Set(['safe', 'single', 'free']));
		for (const name of INSERTS) assert.ok(inserts.has(name), name);
		assert.ok(odd > 20, `odd strides ${odd}`);
	});

	test('generated modules assemble and the checker answers with a certificate or a listed reason', () => {
		let certificates = 0;
		let controls = 0;
		for (let seed = 1; seed <= 100; seed++) {
			const p = plan3(seed);
			const result = certifyOwnership(build3(p));
			if (p.mode === 'safe') controls++;
			if (result.kind === 'certificate') {
				if (p.mode === 'safe') certificates++;
			} else assert.ok(OWNERSHIP_REASONS.includes(result.reason), result.reason);
		}
		assert.ok(controls >= 20, `control plans ${controls}`);
		assert.ok(certificates >= 6, `control plans that certify ${certificates} of ${controls}`);
	});

	test('restoring the strides gives the plain stride expressions and clears the premise flag', () => {
		const p = {
			...plan3(3),
			strideT: '(i32.const 8)',
			strideO: '(i32.const 32)',
			strideOdd: true
		};
		const s = stripStride(p);
		assert.equal(s.strideT, STRIDE_T);
		assert.equal(s.strideO, STRIDE_O);
		assert.equal(s.strideOdd, false);
		assert.equal(stripStride(s).statements, s.statements);
	});

	test('the two-loops carry and the reverse frame carry the shapes the attack list names', () => {
		const base = plan3(1);
		const two = wat3({
			...base,
			frame: 'two-loops',
			carry: true,
			viaCallee: false,
			wrap: false
		});
		assert.ok(two.includes('(i32.store (i32.const 4356)'));
		assert.ok(two.includes('(i32.load (i32.const 4356))'));
		const rev = wat3({ ...base, frame: 'reverse', viaCallee: false, wrap: false });
		assert.ok(rev.includes('(local.set $i (i32.sub (local.get $i) (i32.const 1)))'));
	});

	test('the summary counts verdicts and accepted rows by frame', () => {
		const rows = [
			{ frame: 'top', outcome: 'certificate', verdict: 'ok' },
			{ frame: 'top', outcome: 'isolation' },
			{ frame: 'reverse', outcome: 'certificate', verdict: 'false' }
		] as Row3[];
		const s = summarize(rows);
		assert.equal(s.accepted, 2);
		assert.deepEqual(s.verdicts, [
			['ok', 1],
			['false', 1]
		]);
		assert.deepEqual(s.acceptedByFrame, [
			['top', 1],
			['reverse', 1]
		]);
	});

	test('the freeze check lists the four checker sources with a sha256 each', () => {
		const list = hashes();
		assert.equal(list.length, 4);
		for (const { sha256 } of list) assert.match(sha256, /^[0-9a-f]{64}$/);
	});
});
