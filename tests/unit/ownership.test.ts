import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	assemble,
	BASES,
	COUNTER_USES,
	counterModule,
	driverWat,
	INSERTS,
	moduleOf,
	routeMatches,
	SYNTHETIC,
	wasmOf
} from '../../scripts/research/ownership-modules.ts';
import {
	mutate,
	relWat,
	TOKEN_BASES
} from '../../scripts/research/ownership-relational-modules.ts';
import {
	certifyOwnership,
	guardRecords,
	OWNERSHIP_REASONS,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const certificate = (bytes: Uint8Array) => {
	const r = certifyOwnership(bytes);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const refusal = (bytes: Uint8Array, reason: string) => {
	const r = certifyOwnership(bytes);
	assert.equal(r.kind, 'refusal');
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	assert.ok(OWNERSHIP_REASONS.includes((r as OwnershipRefusal).reason));
	return r as OwnershipRefusal;
};

describe('ownership certificate', () => {
	test('scratch with a covering write certifies and matches the private route', () => {
		const bytes = wasmOf('scratch');
		const c = certificate(bytes);
		assert.deepEqual(c.windows, [{ low: 4096, end: 4160 }]);
		assert.deepEqual(c.copyOut, [[4120, 4128]]);
		assert.ok(verifyOwnership(bytes, c));
		assert.ok(routeMatches(bytes, c.windows, [1, 2, 3]));
		assert.ok(guardRecords(c, [[8192, 8256]]));
		assert.ok(!guardRecords(c, [[4100, 4110]]));
	});

	test('the certificate is bound to the module', () => {
		const c = certificate(wasmOf('scratch'));
		const other = assemble(driverWat({ body: BASES.fill!.join('\n') }));
		assert.ok(!verifyOwnership(other, c));
		assert.ok(!verifyOwnership(wasmOf('scratch'), { ...c, checker: 'other' }));
	});

	test('fill, loop, branch and bounded covers certify', () => {
		for (const name of ['fill', 'loop', 'branch', 'bounded', 'copy']) {
			const bytes = moduleOf(BASES[name]!);
			const c = certificate(bytes);
			assert.ok(routeMatches(bytes, c.windows, [1, 2, 3, 4]), name);
		}
	});

	test('synthetic drivers get the outcome the design predicts', () => {
		const expected: Record<string, string> = {
			clean: 'no-window',
			counter: 'read-before-write',
			rare: 'final-state',
			carry: 'read-before-write',
			cursor: 'allocator'
		};
		for (const [name, reason] of Object.entries(expected)) refusal(wasmOf(name), reason);
		certificate(wasmOf('scratch'));
		assert.deepEqual(
			Object.keys(SYNTHETIC).sort(),
			[...Object.keys(expected), 'scratch'].sort()
		);
	});

	test('state isolation: an import, an indirect call, a global write and a stored record pointer', () => {
		for (const insert of ['import-plain', 'indirect-call', 'global-write', 'global-counter'])
			refusal(moduleOf(BASES.scratch!, insert), 'isolation');
		for (const insert of ['cursor-store', 'table-pointer-store'])
			refusal(moduleOf(BASES.scratch!, insert), 'allocator');
	});

	test('read before write: a read ahead of the init', () => {
		refusal(
			moduleOf([
				'(i32.store (i32.add (local.get $slot) (i32.const 4)) (i32.load (i32.const 4120)))',
				'(i32.store (i32.const 4120) (local.get $sum))'
			]),
			'read-before-write'
		);
		refusal(moduleOf([...BASES.scratch!.slice(1), BASES.scratch![0]!]), 'read-before-write');
	});

	test('aliasing: a bulk operation that straddles or has an unbounded range', () => {
		for (const insert of ['fill-straddle', 'fill-dynamic', 'copy-from-window'])
			refusal(moduleOf(BASES.scratch!, insert), 'aliasing');
		refusal(moduleOf(BASES.scratch!, 'fill-bounded'), 'final-state');
	});

	test('final state: a conditional write and a write at an unbounded address', () => {
		refusal(
			moduleOf([
				...BASES.scratch!,
				'(if (i32.and (local.get $sum) (i32.const 1)) (then (i32.store (i32.const 4132) (i32.const 9))))'
			]),
			'final-state'
		);
		const r = certifyOwnership(moduleOf(BASES.scratch!, 'wide-dynamic-store'));
		assert.equal(r.kind, 'refusal');
	});

	test('escaping addresses: a stored, returned or exported window address', () => {
		for (const insert of [
			'store-address',
			'store-address-field',
			'return-address',
			'import-address'
		])
			refusal(moduleOf(BASES.scratch!, insert), 'escape');
	});

	test('failure: a trap after a window write', () => {
		refusal(moduleOf(BASES.scratch!, 'trap-after-write'), 'failure');
		const early = moduleOf([
			`(if (i32.and (local.get $sum) (i32.const 1)) (then (unreachable)))`,
			...BASES.scratch!
		]);
		certificate(early);
	});

	test('a stack pointer that is not restored is refused', () => {
		const wat = driverWat({
			extra: '(global $sp (mut i32) (i32.const 65536))',
			body: `(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))
				${BASES.scratch!.join('\n')}`
		});
		refusal(assemble(wat), 'isolation');
		const ok = driverWat({
			extra: '(global $sp (mut i32) (i32.const 65536))',
			body: `(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))
				${BASES.scratch!.join('\n')}
				(global.set $sp (i32.add (global.get $sp) (i32.const 16)))`
		});
		certificate(assemble(ok));
	});

	test('a restored counter global that is read as data is not a stack pointer', () => {
		const frame = (body: string) =>
			assemble(
				driverWat({
					extra: '(global $sp (mut i32) (i32.const 65536))',
					body: `(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))
						${BASES.scratch!.join('\n')}
						${body}
						(global.set $sp (i32.add (global.get $sp) (i32.const 16)))`
				})
			);
		certificate(frame('(i32.store (i32.sub (global.get $sp) (i32.const 8)) (local.get $sum))'));
		for (const body of [
			'(i32.store (i32.add (local.get $slot) (i32.const 8)) (global.get $sp))',
			'(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.shr_u (global.get $sp) (i32.const 4)))',
			'(if (i32.gt_u (global.get $sp) (i32.const 1000)) (then (nop)))',
			'(if (global.get $sp) (then (nop)))',
			'(drop (select (i32.const 1) (i32.const 2) (global.get $sp)))'
		])
			refusal(frame(body), 'isolation');
		const ret = driverWat({
			extra: '(global $sp (mut i32) (i32.const 65536))',
			body: BASES.scratch!.join('\n'),
			ret: '(global.get $sp)'
		});
		refusal(assemble(ret), 'isolation');
	});

	test('a local that one record leaves for the next is refused, a stepped counter is not', () => {
		const withQ = (wat: string) =>
			wat.replace('(local $i i32)', '(local $i i32) (local $q i32)');
		const frame = (body: string) => assemble(withQ(driverWat({ body })));
		const scratch = BASES.scratch!.join('\n');
		certificate(frame(scratch));
		certificate(frame(`${scratch} (local.set $q (i32.const 7))`));
		certificate(
			frame(`${scratch} (local.set $q (i32.add (local.get $q) (i32.const 1)))
				(local.set $q (i32.sub (local.get $q) (i32.const 4)))`)
		);
		for (const body of [
			`(i32.store (i32.const 4120) (local.get $sum))
			(i32.store (local.get $slot) (i32.add (i32.load (i32.const 4120)) (local.get $q)))
			(local.set $q (local.get $sum))`,
			`${scratch} (if (i32.and (local.get $sum) (i32.const 1)) (then (local.set $q (local.get $sum))))
			(i32.store offset=4 (local.get $slot) (local.get $q))`
		])
			refusal(frame(body), 'read-before-write');
		certificate(
			frame(`${scratch} (if (i32.and (local.get $sum) (i32.const 1)) (then (local.set $q (local.get $sum))))
				(local.set $q (i32.const 0))`)
		);
	});

	test('a loop counter stored as data is refused, a counter that only addresses records is not', () => {
		for (const [name, use] of Object.entries(COUNTER_USES)) {
			const bytes = counterModule(use);
			if (use.keep) certificate(bytes);
			else if (name !== 'address-constant-base') {
				const r = refusal(bytes, 'read-before-write');
				assert.match(r.detail, /counter/, name);
			}
		}
	});

	test('a counter that indexes a constant table or a branch is refused, a loop test is not', () => {
		const at = (body: string) =>
			certifyOwnership(counterModule({ body: `${BASES.scratch!.join('\n')} ${body}` }));
		for (const body of [
			'(if (i32.eq (local.get $i) (i32.const 3)) (then (i32.store offset=4 (local.get $slot) (i32.const 1))))',
			'(block $skip (br_if $skip (i32.eq (local.get $i) (i32.const 3))) (i32.store offset=4 (local.get $slot) (i32.const 1)))',
			'(block $skip (br_if $skip (i32.ne (local.get $i) (i32.sub (local.get $n) (i32.const 1)))) (i32.store offset=4 (local.get $slot) (i32.const 1)))'
		])
			assert.equal(at(body).kind, 'refusal', body);
		certificate(counterModule(COUNTER_USES['address-slot']!));
	});

	test('a loop test that compares a counter with an offset of the record count is refused', () => {
		const step = '(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)';
		const test = '(br_if $done (i32.ge_u (local.get $i) (local.get $n)))';
		const frame = (end: string) =>
			assemble(
				driverWat({ body: BASES.scratch!.join('\n') })
					.replace(test, '(nop)')
					.replace(step, end)
			);
		const bottom = (cond: string) =>
			`(local.set $i (i32.add (local.get $i) (i32.const 1))) (br_if $done ${cond}) (br $each)`;
		certificate(frame(bottom('(i32.ge_u (local.get $i) (local.get $n))')));
		for (const cond of [
			'(i32.ge_u (local.get $i) (i32.sub (local.get $n) (i32.const 1)))',
			'(i32.eq (local.get $i) (i32.sub (local.get $n) (i32.const 1)))'
		])
			assert.match(refusal(frame(bottom(cond)), 'read-before-write').detail, /counter/);
	});

	test('a loop test through a limit local is judged by the limit value, not by its syntax', () => {
		const step = '(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)';
		const test = '(br_if $done (i32.ge_u (local.get $i) (local.get $n)))';
		const head = '(block $done (loop $each';
		const lim = (set: string, top: string, end: string) =>
			certifyOwnership(
				counterModule({
					body: BASES.scratch!.join('\n'),
					replace: [
						[head, `${set} ${head}`],
						[test, top],
						[step, end]
					]
				})
			);
		const bottom = (cond: string) =>
			`(local.set $i (i32.add (local.get $i) (i32.const 1))) (br_if $done ${cond}) (br $each)`;
		const setLim = (value: string) => `(local.set $q ${value})`;
		const limits: Record<string, string> = {
			copy: '(local.get $n)',
			minus: '(i32.sub (local.get $n) (i32.const 1))',
			plus: '(i32.add (local.get $n) (i32.const 1))',
			select: '(select (local.get $n) (i32.const 5) (i32.load8_u (i32.const 4200)))'
		};
		for (const [name, value] of Object.entries(limits))
			for (const rel of ['i32.ge_u', 'i32.eq'])
				for (const where of ['top', 'bottom']) {
					const cond = `(${rel} (local.get $i) (local.get $q))`;
					const r =
						where === 'top'
							? lim(setLim(value), `(br_if $done ${cond})`, step)
							: lim(setLim(value), '(nop)', bottom(cond));
					const label = `${name} ${rel} ${where}`;
					if (name === 'copy' && rel === 'i32.ge_u')
						assert.equal(r.kind, 'certificate', label);
					else if (name !== 'copy') {
						assert.equal(r.kind, 'refusal', label);
						if (where === 'bottom' || name !== 'minus')
							assert.match((r as OwnershipRefusal).detail, /counter/, label);
					}
				}
	});

	test('the jsmn-shaped token table refuses each mutant that reads a local of the previous record', () => {
		const text = relWat(TOKEN_BASES.tokens!, '', 40);
		const swaps: [string, string, string, number][] = [
			[
				'(br_if $pd (i32.ge_u (local.get $pos) (local.get $len)))',
				'(br_if $pd (i32.ge_u (local.get $tn) (local.get $len)))',
				'the loop test reads the token index',
				0
			],
			[
				'(br_if $pd (i32.ge_u (local.get $pos) (local.get $len)))',
				'(br_if $pd (i32.ge_u (local.get $sup) (local.get $len)))',
				'the loop test reads the super index',
				0
			],
			[
				'(i32.load8_u (i32.add (local.get $p) (local.get $pos)))',
				'(i32.load8_u (i32.add (local.get $p) (local.get $tk)))',
				'the byte is read at the last token pointer',
				0
			],
			[
				'(local.set $tn (i32.load (i32.const 4356)))',
				'(i32.store (i32.const 4356) (i32.add (local.get $tn) (i32.const 2)))\n(local.set $tn (i32.load (i32.const 4356)))',
				'the counter is stored from the last token index',
				0
			]
		];
		certificate(assemble(text));
		for (const [from, to, name] of swaps) {
			const mutant = mutate(text, from, to);
			assert.ok(mutant, name);
			refusal(assemble(mutant), 'read-before-write');
		}
	});

	test('unsupported input is refused with a reason', () => {
		assert.equal(
			(certifyOwnership(new Uint8Array([1, 2, 3])) as OwnershipRefusal).reason,
			'invalid'
		);
		const none = certifyOwnership(wasmOf('scratch'), { entry: 'missing' });
		assert.equal((none as OwnershipRefusal).reason, 'unsupported');
		const budget = certifyOwnership(wasmOf('scratch'), { maxSteps: 50 });
		assert.equal((budget as OwnershipRefusal).reason, 'budget');
	});

	test('every insertion operator is known to the closed reason list', () => {
		for (const [name, add] of Object.entries(INSERTS))
			for (const reason of add.expect)
				assert.ok(reason === 'none' || OWNERSHIP_REASONS.includes(reason as never), name);
	});
});
