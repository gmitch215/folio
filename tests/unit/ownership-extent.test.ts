import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches,
	type AllocBase
} from '../../scripts/research/ownership-alloc-modules.ts';
import {
	EXTENT_BASES,
	extentModule,
	extremeMatches,
	SHIM_FUNCS
} from '../../scripts/research/ownership-extent-modules.ts';
import { assemble } from '../../scripts/research/ownership-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const certificate = (bytes: Uint8Array) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const refusal = (bytes: Uint8Array, reason = 'ptr-deref') => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	return r as OwnershipRefusal;
};

const edited = (name: string, from: string, to: string, extra?: string) => {
	const base: AllocBase = EXTENT_BASES[name]!;
	const statements = base.statements.map((s) => s.replace(from, to));
	assert.notDeepEqual(statements, base.statements, `no ${from} in ${name}`);
	return allocModuleOf(
		{ ...base, extra: [base.extra, extra].filter(Boolean).join('\n') },
		statements
	);
};

describe('allocation extents through symbols', () => {
	test('a count and an index bounded by the allocation size are proved', () => {
		for (const name of Object.keys(EXTENT_BASES)) {
			const bytes = extentModule(name);
			const c = certificate(bytes);
			if (['fill', 'related', 'overlap'].includes(name)) {
				assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
				assert.deepEqual(
					extremeMatches(bytes, c.allocator!.pointerCells, [1, 496, 497, 1000]),
					{ ok: true },
					name
				);
				assert.ok(verifyOwnership(bytes, c), name);
			}
			assert.ok(c.allocator!.derefsProved > 0, name);
		}
	});

	test('a bound learned after a comparison reaches the smaller side through the difference', () => {
		refusal(
			edited(
				'related',
				'i32.le_u (local.get $sum) (local.get $len)',
				'i32.le_u (local.get $len) (local.get $sum)'
			)
		);
	});

	test('a lengths one past the arena would write past it, which the ground truth sees', () => {
		const base = EXTENT_BASES.fill!;
		const bad = allocModuleOf(
			base,
			base.statements.map((s) =>
				s.replace(
					'(i32.const 7) (local.get $len))',
					'(i32.const 7) (i32.shl (local.get $len) (i32.const 4)))'
				)
			)
		);
		assert.equal(extremeMatches(bad, [[4096, 4112]], [495]).ok, false);
	});

	test('a count or index one past the extent is refused', () => {
		const fill = '(memory.fill (local.get $a) (i32.const 7) (local.get $len))';
		refusal(
			edited(
				'fill',
				fill,
				fill.replace('(local.get $len))', '(i32.add (local.get $len) (i32.const 1)))')
			)
		);
		refusal(edited('loop', 'i32.ge_u', 'i32.gt_u'));
		refusal(
			edited(
				'loop',
				'(i32.add (local.get $a) (local.get $k))',
				'(i32.add (local.get $a) (i32.add (local.get $k) (i32.const 1)))'
			)
		);
		const copy = '(call $memcpy (local.get $a) (local.get $p) (local.get $len))';
		refusal(
			edited(
				'copy',
				copy,
				copy.replace('(local.get $len))', '(i32.add (local.get $len) (i32.const 1)))')
			)
		);
		refusal(edited('padded', '(i32.const 0) (i32.const 4))', '(i32.const 0) (i32.const 5))'));
	});

	test('an extent from a value that may be larger than the limit is refused', () => {
		refusal(
			edited('padded', '(br_if $out (i32.gt_u (local.get $len) (i32.const 100000)))', '(nop)')
		);
		refusal(
			edited(
				'fill',
				'(memory.fill (local.get $a) (i32.const 7) (local.get $len))',
				'(memory.fill (local.get $a) (i32.const 7) (local.get $sum))'
			)
		);
	});

	test('a pointer plus a data index with no bound or a negative one is refused', () => {
		refusal(
			edited(
				'loop',
				'(i32.add (local.get $a) (local.get $k))',
				'(i32.add (local.get $a) (local.get $sum))'
			)
		);
		refusal(
			edited(
				'loop',
				'(i32.add (local.get $a) (local.get $k))',
				'(i32.sub (local.get $a) (local.get $k))'
			)
		);
		refusal(
			edited(
				'loop',
				'(i32.ge_u (local.get $k) (local.get $len))',
				'(i32.ge_u (local.get $k) (local.get $sum))'
			)
		);
	});

	test('an unchecked allocation result and a bound on another symbol are refused', () => {
		const guard =
			'(if (local.get $a) (then (memory.fill (local.get $a) (i32.const 7) (local.get $len)) (i32.store (local.get $slot) (i32.load8_u (local.get $a)))))';
		refusal(
			allocModuleOf(EXTENT_BASES.fill!, [
				EXTENT_BASES.fill!.statements[0]!,
				EXTENT_BASES.fill!.statements[1]!,
				'(memory.fill (local.get $a) (i32.const 7) (local.get $len))'
			])
		);
		assert.ok(EXTENT_BASES.fill!.statements[2]!.includes(guard.slice(0, 40)));
		const other = allocModuleOf(EXTENT_BASES.fill!, [
			EXTENT_BASES.fill!.statements[0]!,
			'(local.set $a (call $malloc (local.get $sum)))',
			'(if (local.get $a) (then (memory.fill (local.get $a) (i32.const 7) (local.get $len))))'
		]);
		refusal(other);
	});

	test('the bound is lost across a call that does not hand the symbol back', () => {
		const keep = '(func $keep (param i32) (result i32) (i32.or (local.get 0) (i32.const 0)))';
		const fill = '(memory.fill (local.get $a) (i32.const 7) (local.get $len))';
		certificate(
			edited(
				'fill',
				fill,
				fill.replace('(local.get $len))', '(call $id (local.get $len)))'),
				'(func $id (param i32) (result i32) (i32.add (local.get 0) (i32.const 0)))'
			)
		);
		refusal(
			edited(
				'fill',
				fill,
				fill.replace('(local.get $len))', '(call $keep (local.get $len)))'),
				keep
			)
		);
	});

	test('a smaller second allocation does not carry the first extent', () => {
		const bytes = allocModuleOf(EXTENT_BASES.fill!, [
			EXTENT_BASES.fill!.statements[0]!,
			'(local.set $a (call $malloc (local.get $len)))',
			'(local.set $b (call $malloc (i32.shr_u (local.get $len) (i32.const 1))))',
			'(if (local.get $a) (then (if (local.get $b) (then (memory.fill (local.get $b) (i32.const 7) (local.get $len))))))'
		]);
		refusal(bytes);
	});
});

describe('shim summaries', () => {
	const instance = () => {
		const memory = new WebAssembly.Memory({ initial: 1 });
		const text = `(module (import "env" "memory" (memory 1)) ${SHIM_FUNCS}
			(export "memcpy" (func $memcpy)) (export "memset" (func $memset)))`;
		const exports = new WebAssembly.Instance(
			new WebAssembly.Module(Uint8Array.from(assemble(text))),
			{
				env: { memory }
			}
		).exports as Record<string, (...a: number[]) => number>;
		return { memory, view: new Uint8Array(memory.buffer), exports };
	};

	test('the recognised bodies are a forward byte copy and a byte fill', () => {
		const { view, exports } = instance();
		let seed = 7;
		const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 8;
		for (let round = 0; round < 60; round++) {
			for (let i = 0; i < 600; i++) view[i] = next() & 255;
			const want = view.slice();
			const dst = next() % 200;
			const src = next() % 200;
			const n = next() % 120;
			for (let i = 0; i < n; i++) want[dst + i] = want[src + i]!;
			assert.equal(exports.memcpy!(dst, src, n), dst);
			assert.deepEqual(view.slice(0, 600), want.slice(0, 600), `copy ${dst} ${src} ${n}`);
			const value = next();
			for (let i = 0; i < n; i++) want[dst + i] = value & 255;
			assert.equal(exports.memset!(dst, value, n), dst);
			assert.deepEqual(view.slice(0, 600), want.slice(0, 600), `fill ${dst} ${value} ${n}`);
		}
	});

	test('a long fill certifies without running its loop', () => {
		const n = 100000;
		const statements = [
			`(call $bump_set (local.get $arena) (i32.const ${n + 64}))`,
			`(local.set $a (call $malloc (i32.const ${n})))`,
			`(drop (call $memset (local.get $a) (i32.const 1) (i32.const ${n})))`,
			'(i32.store (local.get $slot) (i32.load8_u offset=5 (local.get $a)))'
		];
		const bytes = allocModuleOf({ statements, extra: SHIM_FUNCS }, statements);
		const started = performance.now();
		const r = certifyOwnership(bytes, { allocator: { arenaBytes: n + 64 } });
		assert.equal(r.kind, 'certificate');
		assert.ok(performance.now() - started < 1000);
	});

	test('a function with another body is analysed, not summarised', () => {
		const changed = SHIM_FUNCS.replace(
			'(i32.const 7)\n    )\n   )\n   (local.set $4',
			'(i32.const 6)\n    )\n   )\n   (local.set $4'
		);
		assert.notEqual(changed, SHIM_FUNCS);
		const base = EXTENT_BASES.shimfill!;
		refusal(allocModuleOf({ ...base, extra: changed }, base.statements));
	});

	test('exact small calls keep their byte cells, and a short fill does not', () => {
		const bytes = extentModule('small');
		const c = certificate(bytes);
		assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3]), { ok: true });
		refusal(edited('small', '(i32.const 56)', '(i32.const 8)'), 'read-before-write');
	});

	test('a count past the arena is refused through the summary', () => {
		refusal(
			edited(
				'shimfill',
				'(call $memset (local.get $a) (i32.const 9) (local.get $len))',
				'(call $memset (local.get $a) (i32.const 9) (i32.add (local.get $len) (i32.const 1)))'
			)
		);
		refusal(
			edited(
				'copy',
				'(local.get $p) (local.get $len))',
				'(local.get $p) (i32.shl (local.get $len) (i32.const 4)))'
			)
		);
	});
});
