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
	build as redteamBuild,
	wat as redteamWat,
	type Plan
} from '../../scripts/research/ownership-redteam.ts';
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

	// the red-team skeletons: one record body between a window store and an output store
	const handModule = (skeleton: Plan['skeleton'], ...statements: string[]) =>
		redteamBuild({
			seed: 0,
			mode: 'single',
			skeleton,
			limit: '(local.get $n)',
			statements: [
				'(i32.store (i32.const 4096) (local.get $sum))',
				'(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.const 1)))',
				...statements
			],
			attacks: [],
			flags: { stack: false, global: false, indirect: 'none', host: false, table: false },
			constTable: []
		});
	const dataByte = '(i32.eq (i32.load8_u (local.get $p)) (i32.const 255))';

	test('memory.size is refused because the slice pool grows memory', () => {
		const size = '(i32.store offset=4 (local.get $slot) (memory.size))';
		for (const skeleton of ['indexed', 'callee'] as const) {
			certificate(handModule(skeleton));
			const r = refusal(handModule(skeleton, size), 'isolation');
			assert.match(r.detail, /memory\.size/);
		}
	});

	test('a return or a branch out of the record loop on a data condition is refused, a loop test is not', () => {
		for (const exit of [
			`(if ${dataByte} (then (return)))`,
			`(br_if $done ${dataByte})`,
			`(br_if $each ${dataByte})`,
			`(if ${dataByte} (then (br $done)))`
		])
			assert.match(
				refusal(handModule('indexed', exit), 'read-before-write').detail,
				/data-exit/
			);
		for (const exit of ['(br $done)', '(return)'])
			refusal(handModule('indexed', exit), 'read-before-write');
		refusal(handModule('pointer', `(br_if $done ${dataByte})`), 'read-before-write');
		certificate(
			handModule('indexed', '(br_if $done (i32.ge_u (local.get $i) (local.get $n)))')
		);
		certificate(handModule('indexed', `(if ${dataByte} (then (nop)))`));
		certificate(handModule('indexed', `(block $skip (br_if $skip ${dataByte}) (nop))`));
		certificate(handModule('callee', `(if ${dataByte} (then (return)))`));
	});

	test('a record loop that can fall off its end on a data path is refused, a flagged repeat is not', () => {
		const step = '(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)';
		const test = '(br_if $done (i32.ge_u (local.get $i) (local.get $n)))';
		const inc = '(local.set $i (i32.add (local.get $i) (i32.const 1)))';
		const loop = (top: string, end: string) =>
			assemble(
				driverWat({ body: BASES.scratch!.join('\n') })
					.replace(test, top)
					.replace(step, end)
			);
		certificate(loop(test, step));
		certificate(loop('(nop)', `${inc} (br_if $each (i32.lt_u (local.get $i) (local.get $n)))`));
		certificate(loop(test, `(block $s (br_if $s ${dataByte}) (nop)) ${inc} (br $each)`));
		for (const [top, end] of [
			['(nop)', `${inc} (if ${dataByte} (then (br $each)))`],
			['(nop)', `${inc} (block $s (br_if $s ${dataByte}) (br $each))`],
			['(nop)', `${inc} (br_if $each ${dataByte})`],
			[test, `${inc} (if ${dataByte} (then (br $each)))`],
			[test, inc]
		] as const)
			assert.match(refusal(loop(top, end), 'read-before-write').detail, /data-exit/, end);
	});

	test('the table and out base parameters read as data are refused, a record pointer is not', () => {
		const copies = [
			['indexed', '(i32.store offset=4 (local.get $slot) (local.get $bt))'],
			['indexed', '(i32.store offset=4 (local.get $slot) (local.get $t))'],
			[
				'indexed',
				'(i32.store offset=4 (local.get $slot) (i32.sub (local.get $bo) (local.get $slot)))'
			],
			['callee', '(i32.store offset=4 (local.get $slot) (local.get $bt))'],
			[
				'callee',
				'(i32.store offset=4 (local.get $slot) (i32.sub (local.get $bo) (local.get $slot)))'
			],
			[
				'callee',
				'(if (i32.eq (local.get $bt) (i32.const 8192)) (then (i32.store offset=8 (local.get $slot) (i32.const 5))))'
			],
			[
				'indexed',
				'(if (i32.eq (local.get $t) (i32.const 8192)) (then (i32.store offset=8 (local.get $slot) (i32.const 5))))'
			],
			// a base or the count used as an address or a size reaches another record in a slice
			['indexed', '(i32.store offset=4 (local.get $slot) (i32.load (local.get $t)))'],
			['indexed', '(i32.store offset=4 (local.get $slot) (i32.load (local.get $bt)))'],
			['callee', '(i32.store offset=4 (local.get $slot) (i32.load (local.get $bo)))'],
			['callee', '(i32.store offset=8 (local.get $bo) (local.get $sum))'],
			[
				'indexed',
				'(memory.copy (i32.add (local.get $slot) (i32.const 8)) (local.get $bt) (i32.const 4))'
			],
			[
				'indexed',
				'(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 7) (i32.and (local.get $bt) (i32.const 63)))'
			],
			[
				'callee',
				'(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 7) (i32.and (local.get $cnt) (i32.const 3)))'
			],
			[
				'indexed',
				'(i32.store offset=4 (local.get $slot) (i32.load8_u (i32.load (i32.add (local.get $t) (i32.shl (local.get $n) (i32.const 4))))))'
			]
		] as const;
		for (const [skeleton, use] of copies) {
			const r = refusal(handModule(skeleton, use), 'read-before-write');
			assert.match(r.detail, /counter-as-data/, use);
		}
		certificate(handModule('indexed'));
		certificate(handModule('callee'));
		certificate(
			handModule(
				'indexed',
				'(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 7) (i32.const 4))'
			)
		);
		certificate(
			handModule(
				'indexed',
				'(i32.store offset=8 (local.get $slot) (i32.load offset=8 (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))))'
			)
		);
		certificate(
			handModule(
				'callee',
				'(i32.store offset=8 (local.get $slot) (i32.load offset=8 (local.get $rp)))'
			)
		);
	});

	test('a pointer copied from the base and stepped is a record pointer, one started from the count is not', () => {
		const rec = `(func $rec (param $t i32) (param $o i32)
			(local $p i32) (local $len i32) (local $k i32) (local $sum i32)
			(local.set $p (i32.load (local.get $t)))
			(local.set $len (i32.load offset=4 (local.get $t)))
			(block $sd (loop $sl
				(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
				(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
				(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))
			(i32.store (i32.const 4120) (local.get $sum))
			(i32.store (local.get $o) (i32.load (i32.const 4120))))`;
		const walk = (start: string, step: string) =>
			assemble(`(module (import "env" "memory" (memory 8 40))
				${rec}
				(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32) (local $cur i32) (local $oc i32)
					${start} (local.set $oc (local.get $o))
					(loop $each
						(call $rec (local.get $cur) (local.get $oc))
						(local.set $cur (i32.${step} (local.get $cur) (i32.const 16)))
						(local.set $oc (i32.add (local.get $oc) (i32.const 64)))
						(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))
			)`);
		certificate(walk('(local.set $cur (local.get $t))', 'add'));
		assert.match(
			refusal(
				walk(
					'(local.set $cur (i32.add (local.get $t) (i32.shl (local.get $n) (i32.const 4))))',
					'sub'
				),
				'read-before-write'
			).detail,
			/counter-as-data/
		);
	});

	test('a table pointer stepped by other than the record size is refused', () => {
		const text = redteamWat({
			seed: 0,
			mode: 'single',
			skeleton: 'callee',
			limit: '(local.get $n)',
			statements: [
				'(i32.store (i32.const 4096) (local.get $sum))',
				'(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.const 1)))'
			],
			attacks: [],
			flags: { stack: false, global: false, indirect: 'none', host: false, table: false },
			constTable: []
		});
		const step = '(local.set $t (i32.add (local.get $t) (i32.const 16)))';
		assert.ok(text.includes(step));
		const c = certificate(assemble(text));
		assert.ok(c.assumptions.some((a) => a.includes('record sizes the caller')));
		const r = refusal(
			assemble(text.replace(step, step.replace('16', '8'))),
			'read-before-write'
		);
		assert.match(r.detail, /stride/);
	});

	test('a record pointer plus an offset made from a base or a counter is no record pointer', () => {
		const field = (v: string, shift: number) =>
			`(i32.and (i32.shr_u (local.get $${v}) (i32.const ${shift})) (i32.const 7))`;
		const at = (v: string, shift = 6) =>
			`(i32.add (local.get $slot) (i32.shl ${field(v, shift)} (i32.const 2)))`;
		const store = (addr: string) => `(i32.store ${addr} (local.get $sum))`;
		const refused: [Plan['skeleton'], string][] = [
			['indexed', store(at('t'))],
			['indexed', store(at('bt'))],
			['indexed', store(at('i', 0))],
			['indexed', store(at('idx', 0))],
			['indexed', `(memory.fill ${at('o')} (i32.const 9) (i32.const 4))`],
			['indexed', `(memory.copy ${at('t')} (local.get $p) (i32.const 4))`],
			[
				'indexed',
				`(i32.store offset=8 (local.get $slot) (i32.load8_u (i32.add (local.get $rp) ${field('t', 6)})))`
			],
			['indexed', store(`(i32.sub (local.get $slot) ${field('bt', 6)})`)],
			[
				'indexed',
				store(
					`(select (local.get $slot) ${at('bt')} (i32.and (local.get $sum) (i32.const 1)))`
				)
			],
			['callee', store(at('bt'))],
			['callee', store(at('bo'))]
		];
		for (const [skeleton, use] of refused)
			assert.match(
				refusal(handModule(skeleton, use), 'read-before-write').detail,
				/counter-as-data/,
				use
			);
		for (const [skeleton, use] of [
			['indexed', store('(i32.add (local.get $slot) (i32.const 8))')],
			['indexed', store('(i32.add (local.get $slot) (i32.shl (i32.const 3) (i32.const 2)))')],
			[
				'indexed',
				'(i32.store offset=8 (local.get $slot) (i32.load8_u (i32.add (local.get $rp) (i32.const 16))))'
			],
			['callee', store('(i32.add (local.get $slot) (i32.const 8))')]
		] as const)
			certificate(handModule(skeleton, use));
	});

	// one record loop of the entry: the record body sits after the sum of the record's bytes
	const sumLoop = `(local.set $k (i32.const 0)) (local.set $sum (i32.const 0))
		(block $sd (loop $sl
			(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
			(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
			(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))`;
	const recordHead = (index: string) => `
		(local.set $p (i32.load (i32.add (local.get $t) (i32.shl ${index} (i32.const 4)))))
		(local.set $len (i32.load offset=4 (i32.add (local.get $t) (i32.shl ${index} (i32.const 4)))))
		(local.set $slot (i32.add (local.get $o) (i32.shl ${index} (i32.const 6))))
		${sumLoop}`;
	const up = (body: string) => `(block $done (loop $each
		(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
		${recordHead('(local.get $i)')}
		${body}
		(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))`;
	const entry = (loops: string) =>
		assemble(`(module (import "env" "memory" (memory 8 40))
			(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)
				(local $i i32) (local $p i32) (local $len i32) (local $k i32) (local $sum i32)
				(local $slot i32) (local $c i32)
				${loops}))`);
	const win = '(i32.store (i32.const 4096) (local.get $sum))';
	const slot = '(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.const 1)))';
	const cell = (at: number) => `(i32.const ${at})`;

	test('a later record loop that reads what an earlier loop wrote is refused, loops with their own cells are not', () => {
		const reset = '(local.set $i (i32.const 0))';
		const carry = entry(
			`${up(`${win} ${slot} (i32.store ${cell(4356)} (local.get $sum))`)} ${reset}
			${up(`(i32.store offset=60 (local.get $slot) (i32.load ${cell(4356)}))`)}`
		);
		assert.match(refusal(carry, 'read-before-write').detail, /before this record loop/);
		// each loop writes a cell before it reads it
		certificate(
			entry(
				`${up(`${win} ${slot}`)} ${reset}
				${up(
					`(i32.store ${cell(4104)} (local.get $sum))
					(i32.store offset=60 (local.get $slot) (i32.load ${cell(4104)}))`
				)}`
			)
		);
		// the second loop rewrites the cell the first loop wrote before it reads it
		certificate(
			entry(
				`${up(`${win} ${slot} (i32.store ${cell(4356)} (local.get $sum))`)} ${reset}
				${up(
					`(i32.store ${cell(4356)} (local.get $sum))
					(i32.store offset=60 (local.get $slot) (i32.load ${cell(4356)}))`
				)}`
			)
		);
	});

	test('a cell stored before the record loop is a baseline only when no record writes it', () => {
		const pre = `(i32.store ${cell(4328)} (i32.const 5))`;
		const rewrite = `(i32.store offset=60 (local.get $slot) (i32.load ${cell(4328)}))
			(i32.store ${cell(4328)} (i32.add (i32.load ${cell(4328)}) (i32.const 1)))`;
		assert.match(
			refusal(entry(`${pre} ${up(`${slot} ${rewrite}`)}`), 'read-before-write').detail,
			/before this record loop/
		);
		certificate(
			entry(
				`${pre} ${up(`${slot} (i32.store offset=60 (local.get $slot) (i32.load ${cell(4328)}))`)}`
			)
		);
		certificate(
			entry(
				`${pre} ${up(`${slot} (i32.store ${cell(4328)} (local.get $sum))
					(i32.store offset=60 (local.get $slot) (i32.load ${cell(4328)}))`)}`
			)
		);
	});

	test('a record loop that visits records in decreasing order is refused, a countdown that indexes none is not', () => {
		const down = (body: string) => `(local.set $i (local.get $n))
			(block $done (loop $each
				(br_if $done (i32.eqz (local.get $i)))
				(local.set $i (i32.sub (local.get $i) (i32.const 1)))
				${recordHead('(local.get $i)')}
				${body}
				(br $each)))`;
		assert.match(
			refusal(entry(down(`${win} ${slot}`)), 'read-before-write').detail,
			/counter-as-data/
		);
		const rec = `(func $rec (param $rp i32) (param $ro i32)
			(local $p i32) (local $len i32) (local $k i32) (local $sum i32)
			(local.set $p (i32.load (local.get $rp)))
			(local.set $len (i32.load offset=4 (local.get $rp)))
			${sumLoop}
			${win}
			(i32.store (local.get $ro) (i32.add (local.get $sum) (i32.const 1))))`;
		const viaCallee = assemble(`(module (import "env" "memory" (memory 8 40))
			${rec}
			(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32) (local $i i32)
				(local.set $i (local.get $n))
				(block $done (loop $each
					(br_if $done (i32.eqz (local.get $i)))
					(local.set $i (i32.sub (local.get $i) (i32.const 1)))
					(call $rec (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))
						(i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6))))
					(br $each)))))`);
		refusal(viaCallee, 'read-before-write');
		// a countdown of the record count that no address uses, next to an ascending record index
		certificate(
			entry(`(local.set $c (local.get $n))
				(block $done (loop $each
					(br_if $done (i32.eqz (local.get $c)))
					(local.set $c (i32.sub (local.get $c) (i32.const 1)))
					${recordHead('(local.get $i)')}
					${win} ${slot}
					(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))`)
		);
	});

	test('a loop test against a base parameter is refused, against the record count it is not', () => {
		const step = '(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)';
		const test = '(br_if $done (i32.ge_u (local.get $i) (local.get $n)))';
		const against = (limit: string) =>
			assemble(
				driverWat({ body: BASES.scratch!.join('\n') })
					.replace(test, '(nop)')
					.replace(
						step,
						`(local.set $i (i32.add (local.get $i) (i32.const 1)))
						(br_if $each (i32.lt_u (local.get $i) ${limit}))`
					)
			);
		certificate(against('(local.get $n)'));
		for (const base of ['$o', '$t'])
			assert.match(
				refusal(against(`(local.get ${base})`), 'read-before-write').detail,
				/counter-as-data/,
				base
			);
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
