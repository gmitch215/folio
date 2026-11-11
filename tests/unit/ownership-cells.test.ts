import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	ALLOC_BASES,
	allocBytes,
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches
} from '../../scripts/research/ownership-alloc-modules.ts';
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

const refusal = (bytes: Uint8Array, reason: string) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	return r as OwnershipRefusal;
};

const edited = (
	base: (typeof ALLOC_BASES)[string],
	change: (statements: string[]) => string[],
	extra?: (text: string) => string
) =>
	allocModuleOf(
		extra ? { ...base, extra: extra(base.extra ?? '') } : base,
		change([...base.statements])
	);
const swap = (statements: string[], from: string, to: string) =>
	statements.map((s) => (s.includes(from) ? s.replace(from, to) : s));
const insertBefore = (statements: string[], marker: string, add: string) => {
	const at = statements.findIndex((s) => s.includes(marker));
	assert.ok(at >= 0, marker);
	return [...statements.slice(0, at), add, ...statements.slice(at)];
};

describe('allocator pieces: function-pointer cells', () => {
	const fnptr = ALLOC_BASES.fnptr!;
	const indirect = (index: string) =>
		`(i32.store offset=20 (local.get $slot) (call_indirect (type $ft) (i32.const 1) ${index}))`;
	const withIndirect = (index: string, extra?: (text: string) => string) =>
		edited(fnptr, (s) => insertBefore(s, 'local.set $a', indirect(index)), extra);

	test('a table index loaded from a stack cell or from constant data resolves through the element segment', () => {
		const bytes = allocBytes('fnptr');
		const c = certificate(bytes);
		assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3]), { ok: true });
		assert.ok(verifyOwnership(bytes, c));
		const direct = withIndirect('(i32.const 2)');
		assert.deepEqual(relocationMatches(direct, certificate(direct), [1, 2, 3]), { ok: true });
	});

	test('an out-of-range index, an empty slot and another signature are refused', () => {
		refusal(withIndirect('(i32.const 9)'), 'isolation');
		refusal(withIndirect('(i32.const 0)'), 'isolation');
		const mismatch = withIndirect('(i32.const 4)', (t) =>
			t
				.replace(
					'(elem (i32.const 1) $falloc $fadd $fmul $fid)',
					'(elem (i32.const 1) $falloc $fadd $fmul $none)'
				)
				.concat('\n(func $none (param i32 i32) (result i32) (local.get 0))')
		);
		refusal(mismatch, 'isolation');
	});

	test('an index that depends on data, or on a cell overwritten by data, is refused', () => {
		refusal(withIndirect('(i32.and (local.get $sum) (i32.const 3))'), 'isolation');
		refusal(
			edited(fnptr, (s) =>
				insertBefore(s, 'local.set $a', '(i32.store (global.get $sp) (local.get $sum))')
			),
			'isolation'
		);
		refusal(
			edited(fnptr, (s) =>
				insertBefore(s, 'local.set $a', '(i32.store8 (global.get $sp) (local.get $sum))')
			),
			'isolation'
		);
	});

	test('a table the host or the closure can change is refused', () => {
		const text = (add: string) => (t: string) => `${t}\n${add}`;
		refusal(withIndirect('(i32.const 2)', text('(export "tbl" (table 0))')), 'isolation');
		const setter = edited(fnptr, (s) =>
			insertBefore(s, 'local.set $a', '(table.set (i32.const 2) (ref.func $fmul))')
		);
		refusal(setter, 'unsupported');
	});

	test('a data-segment byte that a store can reach is not a constant', () => {
		const store = '(i32.store (i32.const 100000) (local.get $sum))';
		refusal(
			edited(fnptr, (s) => insertBefore(s, 'local.set $a', store)),
			'isolation'
		);
		// the store comes after the load; the summary is flow-insensitive, so it still counts
		refusal(
			edited(fnptr, (s) => [...s.slice(0, -1), store, s[s.length - 1]!]),
			'isolation'
		);
		const far = '(i32.store (i32.const 100008) (local.get $sum))';
		const bytes = edited(fnptr, (s) => insertBefore(s, 'local.set $a', far));
		assert.deepEqual(relocationMatches(bytes, certificate(bytes), [1, 2, 3]), { ok: true });
	});

	test('a function pointer to an import is refused', () => {
		const imported = (t: string) =>
			`(import "env" "g" (func $imp (param i32) (result i32)))\n${t.replace('(table 5', '(table 6').replace('$fid)', '$fid $imp)')}`;
		// slot 5 names the import; slots 1 to 4 are unchanged, so the module is fine until something calls slot 5
		assert.equal(
			certifyOwnership(
				edited(fnptr, (s) => s, imported),
				options
			).kind,
			'certificate'
		);
		refusal(withIndirect('(i32.const 5)', imported), 'isolation');
	});
});

describe('allocator pieces: stack-address cells', () => {
	const stackptr = ALLOC_BASES.stackptr!;
	const tail = (...add: string[]) =>
		edited(stackptr, (s) => [...s.slice(0, -1), ...add, s[s.length - 1]!]);

	test('a stack address stored in a stack object, reloaded, compared and dereferenced certifies', () => {
		const bytes = allocBytes('stackptr');
		const c = certificate(bytes);
		assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3, 4, 5, 6]), { ok: true });
		assert.ok(verifyOwnership(bytes, c));
	});

	test('a stack address never reaches the output, a window, the arena, the caller frame or a return', () => {
		const cases: [string, string[]][] = [
			['output', ['(i32.store offset=24 (local.get $slot) (local.get $n))']],
			['window', ['(i32.store (i32.const 4200) (local.get $n))']],
			['arena', ['(i32.store (call $malloc (i32.const 8)) (local.get $n))']],
			['caller frame', ['(i32.store offset=64 (global.get $sp) (local.get $n))']],
			[
				'derived',
				['(i32.store offset=24 (local.get $slot) (i32.and (local.get $n) (i32.const 255)))']
			],
			[
				'unknown slot',
				[
					'(i32.store (i32.add (global.get $sp) (i32.and (local.get $sum) (i32.const 8))) (local.get $n))'
				]
			]
		];
		for (const [name, add] of cases) refusal(tail(...add), 'isolation');
		const returned = allocModuleOf(
			stackptr,
			stackptr.statements
				.slice(0, -1)
				.concat(['(local.set $d (local.get $n))', stackptr.statements.at(-1)!]),
			undefined
		);
		assert.equal(certifyOwnership(returned, options).kind, 'certificate');
	});

	test('a stack address read back as data, partly overwritten or dropped by a join is refused', () => {
		refusal(
			tail('(i32.store offset=24 (local.get $slot) (i32.load8_u (global.get $sp)))'),
			'isolation'
		);
		refusal(
			tail(
				'(i32.store offset=24 (local.get $slot) (i32.load16_u offset=2 (global.get $sp)))'
			),
			'isolation'
		);
		refusal(
			edited(stackptr, (s) =>
				insertBefore(s, 'local.set $n', '(i32.store8 (global.get $sp) (local.get $sum))')
			),
			'isolation'
		);
		refusal(
			tail(
				'(memory.copy (i32.add (local.get $slot) (i32.const 32)) (global.get $sp) (i32.const 8))'
			),
			'isolation'
		);
	});
});

describe('allocator pieces: stack reads and frames', () => {
	test('a read above the entry stack pointer is refused (the adversary found a certified one)', () => {
		const widths = ALLOC_BASES.widths!;
		const s = [...widths.statements];
		const last = s.length - 1;
		[s[last - 1], s[last]] = [s[last]!, s[last - 1]!];
		refusal(allocModuleOf(widths, s), 'isolation');
	});

	test('a stack byte read before this record writes it is refused (the adversary found a certified one)', () => {
		const base = ALLOC_BASES.stackptr!;
		const without = base.statements.filter(
			(s) => !s.includes('offset=32 (global.get $sp) (local.get $sum)')
		);
		assert.equal(without.length, base.statements.length - 1);
		refusal(allocModuleOf(base, without), 'read-before-write');
	});
});
