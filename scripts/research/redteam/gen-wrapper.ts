import { buildWat, outputDirectory, runBatch, type Entry } from './lib.ts';

const dir = outputDirectory();

// wrapper shape, state outside the loop, conditioning pairs, length and position dependence
const BODY = `(i32.xor (i32.shl (i32.xor (local.get 0) (local.get 1)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3)))`;
const STEP = `(func $step (export "transition") (param i32 i32) (result i32) ${BODY})`;
const entries: Entry[] = [];
const push = (id: string, group: string, note: string, source: string, memory?: string) => {
	try {
		entries.push({ id, group, note, source, bytes: buildWat(source, memory) });
	} catch (e) {
		console.log('build failed', id, String(e).split('\n')[0]);
	}
};

const LOAD = '(i32.load8_u (local.get 1))';
const INC = '(local.set 1 (i32.add (local.get 1) (i32.const 1)))';
const BACK = '(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))';
const CALL = (load = LOAD) => `(local.set 0 (call $step (local.get 0) ${load}))`;
const wrap = (
	inner: string,
	opts: { locals?: string; tail?: string; pre?: string } = {}
) => `(func $update (export "update") (param i32 i32 i32) (result i32) ${opts.locals ?? ''}
	(block $done (br_if $done (i32.eqz (local.get 2))) ${opts.pre ?? ''}
		(loop $again ${inner}))
	${opts.tail ?? '(local.get 0)'})`;

const W = (id: string, note: string, text: string) =>
	push(`wrap/${id}/stream`, 'wrapper', note, `${STEP} ${text}`);
W('control', 'unchanged template', wrap(`${CALL()} ${INC} ${BACK}`));
W(
	'ptr-plus-2',
	'pointer advances by 2',
	wrap(`${CALL()} (local.set 1 (i32.add (local.get 1) (i32.const 2))) ${BACK}`)
);
W(
	'ptr-plus-0',
	'pointer does not advance',
	wrap(`${CALL()} (local.set 1 (i32.add (local.get 1) (i32.const 0))) ${BACK}`)
);
W(
	'ptr-data',
	'pointer advances by a data value',
	wrap(
		`${CALL()} (local.set 1 (i32.add (local.get 1) (i32.add (i32.and (local.get 0) (i32.const 1)) (i32.const 1)))) ${BACK}`
	)
);
W(
	'ptr-minus',
	'pointer walks backwards',
	wrap(`${CALL()} (local.set 1 (i32.add (local.get 1) (i32.const -1))) ${BACK}`)
);
W(
	'len-minus-2',
	'length counts down by 2',
	wrap(`${CALL()} ${INC} (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -2))))`)
);
W('extra-local', 'unused local', wrap(`${CALL()} ${INC} ${BACK}`, { locals: '(local i32)' }));
W(
	'count-up',
	'index loop',
	`(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32) (local $i i32)
	(block $d (loop $a (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
		(local.set $s (call $step (local.get $s) (i32.load8_u (i32.add (local.get $p) (local.get $i)))))
		(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $a))) (local.get $s))`
);
W(
	'early-exit-state',
	'exit when state is zero',
	wrap(`${CALL()} (br_if $done (i32.eqz (local.get 0))) ${INC} ${BACK}`)
);
W(
	'early-exit-len',
	'exit when remaining count is 5',
	wrap(`${CALL()} ${INC} (br_if $done (i32.eq (local.get 2) (i32.const 5))) ${BACK}`)
);
W(
	'second-exit-const',
	'exit when ptr reaches a constant',
	wrap(`${CALL()} ${INC} (br_if $done (i32.eq (local.get 1) (i32.const 1310720))) ${BACK}`)
);
W(
	'skip-iter',
	'skip the step when the byte is 0x41',
	wrap(`(if (i32.ne ${LOAD} (i32.const 65)) (then ${CALL()})) ${INC} ${BACK}`)
);
W(
	'br-table',
	'br_table to the loop head',
	wrap(
		`${CALL()} ${INC} (local.set 2 (i32.add (local.get 2) (i32.const -1))) (br_table $done $again (i32.ne (local.get 2) (i32.const 0)))`
	)
);
W('load8s', 'signed byte load', wrap(`${CALL('(i32.load8_s (local.get 1))')} ${INC} ${BACK}`));
W(
	'load-off1',
	'load offset 1',
	wrap(`${CALL('(i32.load8_u offset=1 (local.get 1))')} ${INC} ${BACK}`)
);
W(
	'load-off0',
	'load offset 0 spelled out',
	wrap(`${CALL('(i32.load8_u offset=0 align=1 (local.get 1))')} ${INC} ${BACK}`)
);
W(
	'load-ptr-plus-3',
	'load from ptr plus 3',
	wrap(`${CALL('(i32.load8_u (i32.add (local.get 1) (i32.const 3)))')} ${INC} ${BACK}`)
);
W(
	'load-two',
	'two loads per iteration',
	wrap(
		`(local.set 0 (call $step (call $step (local.get 0) ${LOAD}) (i32.load8_u offset=1 (local.get 1)))) (local.set 1 (i32.add (local.get 1) (i32.const 2))) ${BACK}`
	)
);
W(
	'swap-args',
	'step arguments swapped',
	wrap(`(local.set 0 (call $step ${LOAD} (local.get 0))) ${INC} ${BACK}`)
);
W('load16', 'a 16-bit load', wrap(`${CALL('(i32.load16_u (local.get 1))')} ${INC} ${BACK}`));
W(
	'tail-xor',
	'final xor on every call',
	wrap(`${CALL()} ${INC} ${BACK}`, { tail: '(i32.xor (local.get 0) (i32.const -1))' })
);
W(
	'tail-and',
	'final mask',
	wrap(`${CALL()} ${INC} ${BACK}`, { tail: '(i32.and (local.get 0) (i32.const 0xffff))' })
);
W(
	'pre-xor',
	'pre-xor in the wrapper',
	wrap(`${CALL()} ${INC} ${BACK}`, {
		pre: '(local.set 0 (i32.xor (local.get 0) (i32.const -1)))'
	})
);
W(
	'pre-post-xor',
	'pre and post xor in the wrapper',
	wrap(`${CALL()} ${INC} ${BACK}`, {
		pre: '(local.set 0 (i32.xor (local.get 0) (i32.const -1)))',
		tail: '(i32.xor (local.get 0) (i32.const -1))'
	})
);
W(
	'store-in-loop',
	'wrapper stores the state at address 8',
	wrap(`${CALL()} (i32.store (i32.const 8) (local.get 0)) ${INC} ${BACK}`)
);
W(
	'global-in-loop',
	'wrapper counts in a global',
	`(global $g (mut i32) (i32.const 0)) ${wrap(`${CALL()} (global.set $g (i32.add (global.get $g) (i32.const 1))) ${INC} ${BACK}`, { tail: '(i32.xor (local.get 0) (global.get $g))' })}`
);
W(
	'block-extra',
	'extra empty block around the loop body',
	wrap(`(block ${CALL()}) ${INC} ${BACK}`)
);
W('nop', 'nop inside the loop', wrap(`(nop) ${CALL()} ${INC} ${BACK}`));
W(
	'return-early',
	'return in loop on length 70000',
	wrap(
		`${CALL()} ${INC} (if (i32.eq (local.get 2) (i32.const 70000)) (then (return (local.get 0)))) ${BACK}`
	)
);
W(
	'tee-ptr-load',
	'tee the pointer in the load',
	wrap(
		`(local.set 0 (call $step (local.get 0) (i32.load8_u (local.tee 1 (i32.add (local.get 1) (i32.const 0)))))) ${INC} ${BACK}`
	)
);
W(
	'inc-via-tee',
	'pointer advanced by tee form',
	wrap(`${CALL()} (drop (local.tee 1 (i32.add (local.get 1) (i32.const 1)))) ${BACK}`)
);
W(
	'state-in-memory',
	'state kept in memory by the wrapper',
	wrap(
		`(i32.store (i32.const 16) ${`(call $step (i32.load (i32.const 16)) ${LOAD})`}) ${INC} ${BACK}`,
		{ tail: '(i32.load (i32.const 16))' }
	)
);

// state outside the loop, around an unchanged template
const base = `${STEP} ${wrap(`${CALL()} ${INC} ${BACK}`)}`;
const S = (id: string, note: string, extra: string, memory?: string, tail = base) =>
	push(`state/${id}/stream`, 'state', note, `${extra} ${tail}`, memory);
S('global-unused', 'mutable global never touched', '(global $g (mut i32) (i32.const 7))');
S('global-exported', 'exported mutable global', '(global $g (export "g") (mut i32) (i32.const 7))');
S('global-imm', 'immutable global', '(global $g i32 (i32.const 7))');
S(
	'other-export-poke',
	'second export stores into memory',
	'(func $poke (export "poke") (i32.store (i32.const 1048576) (i32.const 99)))'
);
S(
	'other-export-grow',
	'second export grows memory',
	'(func $grow (export "grow") (result i32) (memory.grow (i32.const 1)))'
);
S(
	'other-export-global',
	'second export bumps a global',
	'(global $g (mut i32) (i32.const 0)) (func $bump (export "bump") (global.set $g (i32.add (global.get $g) (i32.const 1))))'
);
S(
	'table-callind',
	'table, elem and call_indirect in another export',
	'(table 2 funcref) (elem (i32.const 0) $step) (func $ci (export "ci") (result i32) (call_indirect (param i32 i32) (result i32) (i32.const 1) (i32.const 2) (i32.const 0)))'
);
S('start-func', 'start function', '(func $st (i32.store (i32.const 4) (i32.const 1))) (start $st)');
S('start-noop', 'empty start function', '(func $st (nop)) (start $st)');
S(
	'import-noop',
	'no-op import',
	'(import "env" "nop" (func $nop)) (memory (export "memory") 32 512)',
	''
);
S(
	'import-unused-global',
	'imported global',
	'(import "env" "g" (global $ig i32)) (memory (export "memory") 32 512)',
	''
);
S('data-active', 'active data segment', '(data (i32.const 0) "abc")');
S(
	'data-active-far',
	'active data segment inside the input area',
	'(data (i32.const 1048576) "clobber")'
);
S('data-passive', 'passive data segment', '(data "abc")');
S(
	'data-passive-fill',
	'passive data used by another export',
	'(data $d "abc") (func $cp (export "cp") (memory.init $d (i32.const 0) (i32.const 0) (i32.const 3)))'
);
S('multi-export', 'same function exported twice', '(export "update2" (func $update))');
S('multi-export-step', 'step exported twice', '(export "t2" (func $step))');
S(
	'memory-fill-export',
	'another export fills memory',
	'(func $fill (export "fill") (memory.fill (i32.const 1048576) (i32.const 1) (i32.const 4096)))'
);
S(
	'memory-copy-export',
	'another export copies memory',
	'(func $cp2 (export "cp2") (memory.copy (i32.const 1048576) (i32.const 0) (i32.const 4096)))'
);
S(
	'table-ops-export',
	'table.grow in another export',
	'(table $t 1 funcref) (func $tg (export "tg") (drop (table.grow $t (ref.null func) (i32.const 1))))'
);
S(
	'step-reads-global',
	'step reads an immutable global',
	'(global $g i32 (i32.const 5))',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (i32.xor (global.get $g) ${BODY})) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-reads-mut-global',
	'step reads a mutable global never written',
	'(global $g (mut i32) (i32.const 5))',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (i32.xor (global.get $g) ${BODY})) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-writes-global',
	'step bumps a mutable global and mixes it in',
	'(global $g (mut i32) (i32.const 0))',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (global.set $g (i32.add (global.get $g) (i32.const 1))) (i32.xor (global.get $g) ${BODY})) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-stores',
	'step stores to memory at 32',
	'',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (i32.store (i32.const 32) (local.get 0)) ${BODY}) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-loads-table',
	'step reads a table in memory',
	'(data (i32.const 64) "\\01\\02\\03\\04")',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (i32.xor (i32.load8_u (i32.const 64)) ${BODY})) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-calls',
	'step calls a helper',
	'(func $h (param i32) (result i32) (local.get 0))',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (call $h ${BODY})) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S(
	'step-grows',
	'step grows memory',
	'',
	undefined,
	`(func $step (export "transition") (param i32 i32) (result i32) (drop (memory.grow (i32.const 0))) ${BODY}) ${wrap(`${CALL()} ${INC} ${BACK}`)}`
);
S('memory-shared', 'shared memory', '', '(memory (export "memory") 32 512 shared)');
S('memory-import', 'imported memory', '', '(import "env" "memory" (memory 32 512))');
S(
	'memory-small',
	'memory too small for the input at 1 MiB',
	'',
	'(memory (export "memory") 2 512)'
);
S('memory-nomax', 'memory without maximum', '', '(memory (export "memory") 32)');

// conditioning pairs in inline loops
const LF = (
	pre: string,
	post: string,
	step = '(local.set 0 (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3))))',
	locals = '(local i32 i32 i32)'
) => `(func $update (export "update") (param i32 i32 i32) (result i32) ${locals}
	(block $g (br_if $g (i32.eqz (local.get 2)))
		${pre}
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) ${step}
			${INC} (br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1)))))
		${post})
	(local.get 0))`;
const xr = (c: string) => `(local.set 0 (i32.xor (local.get 0) (i32.const ${c})))`;
const Cc = (id: string, note: string, text: string) =>
	push(`cond/${id}/loop`, 'conditioning', note, text);
Cc('same', 'pre and post xor -1', LF(xr('-1'), xr('-1')));
Cc('same-bits', 'pre and post xor 0xff00ff00', LF(xr('0xff00ff00'), xr('0xff00ff00')));
Cc('diff-all', 'pre -1, post 0', LF(xr('-1'), ''));
Cc('diff-low-byte', 'pre -1, post 0xffffff00', LF(xr('-1'), xr('0xffffff00')));
Cc('diff-one-bit', 'pre 1, post 3', LF(xr('1'), xr('3')));
Cc('diff-top-bit', 'pre 0x80000000, post 0', LF(xr('0x80000000'), xr('0')));
Cc('pre-only', 'pre only', LF(xr('5'), ''));
Cc('post-only', 'post only', LF('', xr('5')));
Cc('none', 'no conditioning', LF('', ''));
Cc(
	'twice-pre',
	'pre is two xors that combine to the post',
	LF(`${xr('0xf0')} ${xr('0x0f')}`, xr('0xff'))
);
Cc('twice-post', 'post is two xors', LF(xr('0xff'), `${xr('0xf0')} ${xr('0x0f')}`));
Cc(
	'rotl-pre',
	'pre rotates',
	LF(
		'(local.set 0 (i32.rotl (local.get 0) (i32.const 1)))',
		'(local.set 0 (i32.rotr (local.get 0) (i32.const 1)))'
	)
);
Cc(
	'shift-pre',
	'pre shifts left, post shifts right',
	LF(
		'(local.set 0 (i32.shl (local.get 0) (i32.const 1)))',
		'(local.set 0 (i32.shr_u (local.get 0) (i32.const 1)))'
	)
);
Cc(
	'shift-zero-pre',
	'pre shifts by 32 (identity)',
	LF('(local.set 0 (i32.shl (local.get 0) (i32.const 32)))', '')
);
Cc(
	'and-ff-pre',
	'pre masks the state',
	LF('(local.set 0 (i32.and (local.get 0) (i32.const 0xffff)))', '')
);
Cc(
	'and-all-pre',
	'pre ands with -1',
	LF('(local.set 0 (i32.and (local.get 0) (i32.const -1)))', '')
);
Cc(
	'len-pre',
	'pre xors the length',
	LF(
		'(local.set 0 (i32.xor (local.get 0) (local.get 2)))',
		'(local.set 0 (i32.xor (local.get 0) (i32.const 0)))'
	)
);
Cc(
	'len-post',
	'post xors the length',
	LF('', '(local.set 0 (i32.xor (local.get 0) (local.get 2)))')
);
Cc(
	'ptr-post',
	'post xors the pointer',
	LF('', '(local.set 0 (i32.xor (local.get 0) (local.get 1)))')
);
Cc(
	'post-threshold',
	'post only when the length was over a threshold',
	LF(
		xr('-1'),
		'(if (i32.ge_u (local.get 1) (i32.const 1310720)) (then (local.set 0 (i32.xor (local.get 0) (i32.const -1)))))'
	)
);
Cc(
	'pre-threshold',
	'pre only when the length is over 1000',
	LF(
		'(if (i32.ge_u (local.get 2) (i32.const 1000)) (then (local.set 0 (i32.xor (local.get 0) (i32.const -1)))))',
		xr('-1')
	)
);
Cc(
	'diff-locals',
	'pre and post through different temp locals',
	LF(
		'(local.set 0 (block (result i32) (local.set 4 (i32.xor (local.get 0) (i32.const -1))) (local.get 4)))',
		'(local.set 0 (block (result i32) (local.set 5 (i32.xor (local.get 0) (i32.const -1))) (local.get 5)))',
		undefined,
		'(local i32 i32 i32 i32 i32)'
	)
);
Cc(
	'pre-uses-byte-load',
	'pre loads the first byte',
	LF('(local.set 0 (i32.xor (local.get 0) (i32.load8_u (local.get 1))))', xr('0'))
);
Cc(
	'inside-loop-pre',
	'conditioning inside the loop only',
	LF(
		'',
		'',
		`(local.set 0 (i32.xor (local.get 0) (i32.const -1))) (local.set 0 (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3)))) (local.set 0 (i32.xor (local.get 0) (i32.const -1)))`
	)
);
Cc(
	'post-xor-self',
	'post xors state with itself shifted by 32',
	LF(xr('-1'), '(local.set 0 (i32.xor (local.get 0) (i32.shr_u (local.get 0) (i32.const 32))))')
);
Cc(
	'pre-tee-order',
	'pre uses a tee inside xor',
	LF(
		'(local.set 0 (i32.xor (local.tee 4 (local.get 0)) (i32.const -1)))',
		xr('-1'),
		undefined,
		'(local i32 i32 i32)'.replace('i32 i32 i32', 'i32 i32 i32 i32 i32')
	)
);
Cc(
	'step-cond-const-const',
	'step includes a constant',
	LF(
		xr('9'),
		xr('9'),
		'(local.set 0 (i32.xor (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3))) (i32.const 0x1234)))'
	)
);

// length and position dependence that a structural check could miss
const L = (id: string, note: string, text: string) => push(`len/${id}/loop`, 'length', note, text);
const LOOP = (
	lenExtra: string,
	ptrStep = '1',
	tail = '',
	stepExtra = ''
) => `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3)))) ${stepExtra}
			(local.set 1 (i32.add (local.get 1) (i32.const ${ptrStep}))) ${lenExtra}
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))) ${tail})
	(local.get 0))`;
L('control', 'plain loop', LOOP(''));
L(
	'extra-when-eq',
	'xor when remaining == 70000',
	LOOP(
		'',
		'1',
		'',
		'(if (i32.eq (local.get 2) (i32.const 70000)) (then (local.set 0 (i32.xor (local.get 0) (i32.const 1)))))'
	)
);
L(
	'extra-when-ptr-aligned',
	'xor when ptr is 4096 aligned',
	LOOP(
		'',
		'1',
		'',
		'(if (i32.eqz (i32.and (local.get 1) (i32.const 4095))) (then (local.set 0 (i32.xor (local.get 0) (i32.const 1)))))'
	)
);
L(
	'ptr-parity',
	'byte xor ptr parity',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (i32.and (local.get 1) (i32.const 1))))')
);
L(
	'ptr-used-as-data',
	'xor pointer low byte',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (local.get 1)))')
);
L(
	'len-used-as-data',
	'xor length',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (local.get 2)))')
);
L('ptr-step-2', 'ptr by 2', LOOP('', '2'));
L('ptr-step-0', 'ptr by 0', LOOP('', '0'));
L('ptr-step-neg', 'ptr by -1', LOOP('', '-1'));
L('ptr-step-wrap', 'ptr by 4294967295 (same as -1)', LOOP('', '4294967295'));
L(
	'len-extra-dec',
	'len decremented twice',
	LOOP('(local.set 2 (i32.add (local.get 2) (i32.const -1)))')
);
L(
	'len-extra-inc',
	'len incremented then decremented',
	LOOP('(local.set 2 (i32.add (local.get 2) (i32.const 1)))')
);
L(
	'store-in-loop',
	'store into memory',
	LOOP('', '1', '', '(i32.store8 (i32.const 100) (local.get 0))')
);
L(
	'store-input',
	'store back into the input',
	LOOP('', '1', '', '(i32.store8 (local.get 1) (local.get 0))')
);
L(
	'call-in-loop',
	'call a helper',
	LOOP('', '1', '', '(drop (call $update2 (i32.const 0) (i32.const 0) (i32.const 0)))').replace(
		'(func $update',
		'(func $update2 (param i32 i32 i32) (result i32) (local.get 0)) (func $update'
	)
);
L(
	'load-two-same',
	'two loads from the same pointer',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (i32.load8_u (local.get 1))))')
);
L(
	'load-two-different',
	'second load at ptr+1',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (i32.load8_u offset=1 (local.get 1))))')
);
L(
	'load-off-in-step',
	'load via offset 0 explicit',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (i32.load8_u offset=0 (local.get 1))))')
);
L(
	'load-signed',
	'signed load',
	LOOP('', '1', '', '(local.set 0 (i32.xor (local.get 0) (i32.load8_s (local.get 1))))')
);
L(
	'load-after-incr-order',
	'load placed after the pointer increment is impossible; read a second time after incr via statement order',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`
);
L(
	'loop-carried-local',
	'a local carries the previous byte',
	LOOP(
		'',
		'1',
		'',
		'(local.set 0 (i32.xor (local.get 0) (local.get 4))) (local.set 4 (local.get 3))'
	)
);
L(
	'loop-carried-set-first',
	'local set then read in the same iteration',
	LOOP(
		'',
		'1',
		'',
		'(local.set 4 (local.get 3)) (local.set 0 (i32.xor (local.get 0) (local.get 4)))'
	)
);
L(
	'loop-carried-count',
	'local counts iterations',
	LOOP(
		'',
		'1',
		'',
		'(local.set 4 (i32.add (local.get 4) (i32.const 1))) (local.set 0 (i32.xor (local.get 0) (i32.and (local.get 4) (i32.const 1))))'
	)
);
L(
	'guard-ne',
	'guard is len != 0 spelled as br_if on len',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`
);
L(
	'no-guard',
	'no zero-length guard (len 0 wraps)',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`
);
L(
	'guard-lt',
	'guard len < 4 skipped',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.lt_u (local.get 2) (i32.const 4)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`
);
L(
	'result-tail-xor',
	'return state xor 1',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(i32.xor (local.get 0) (i32.const 1)))`
);
L(
	'return-other-local',
	'returns local 3',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 3))`
);
L(
	'different-params',
	'state in param 1 position',
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(local.set 0 (i32.xor (local.get 0) (i32.const 0))) (local.get 0))`
);

runBatch(entries, dir, 'wrapper');
