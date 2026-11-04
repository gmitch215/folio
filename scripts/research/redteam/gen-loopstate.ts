import { buildWat, outputDirectory, runBatch, type Entry } from './lib.ts';

const dir = outputDirectory();

// state outside the loop, inline-loop form, plus a few more conditioning and entry-shape cases
const UPDATE = `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`;
const entries: Entry[] = [];
const S = (id: string, note: string, extra: string, memory?: string, update = UPDATE) => {
	const source = `${extra} ${update}`;
	try {
		entries.push({
			id: `loopstate/${id}/loop`,
			group: 'loopstate',
			note,
			source,
			bytes: buildWat(source, memory)
		});
	} catch (e) {
		console.log('build failed', id, String(e).split('\n')[0]);
	}
};
S('control', 'plain', '');
S(
	'start',
	'start function stores into memory',
	'(func $st (i32.store (i32.const 4) (i32.const 1))) (start $st)'
);
S('start-noop', 'empty start', '(func $st (nop)) (start $st)');
S('data-active', 'active data', '(data (i32.const 0) "abc")');
S('data-input', 'active data inside the input area', '(data (i32.const 1048576) "clobber")');
S('data-passive', 'passive data', '(data "abc")');
S('global-mut', 'mutable global never used', '(global $g (mut i32) (i32.const 1))');
S('global-exp', 'exported mutable global', '(global $g (export "g") (mut i32) (i32.const 1))');
S(
	'import-fn',
	'imported function',
	'(import "env" "f" (func $f)) (memory (export "memory") 32 512)',
	''
);
S('table', 'table and elem', '(table 1 funcref) (elem (i32.const 0) $update)');
S(
	'other-export-store',
	'other export writes memory',
	'(func $w (export "w") (i32.store8 (i32.const 1048576) (i32.const 7)))'
);
S(
	'other-export-grow',
	'other export grows memory',
	'(func $gr (export "gr") (result i32) (memory.grow (i32.const 1)))'
);
S('multi-export', 'same function exported twice', '(export "u2" (func $update))');
S('memory-shared', 'shared memory', '', '(memory (export "memory") 32 512 shared)');
S('memory-nomax', 'no max', '', '(memory (export "memory") 32)');
S(
	'extra-local-unused',
	'extra unused local',
	'',
	undefined,
	UPDATE.replace('(local i32)', '(local i32 i32 f64)')
);
S(
	'param-name-swap',
	'state in param 0, ptr 1, len 2, but swapped use: len in position 1',
	'',
	undefined,
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
	(block $g (br_if $g (i32.eqz (local.get 1)))
		(loop $l (local.set 3 (i32.load8_u (local.get 2)))
			(local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 2 (i32.add (local.get 2) (i32.const 1)))
			(br_if $l (local.tee 1 (i32.add (local.get 1) (i32.const -1))))))
	(local.get 0))`
);
S(
	'tee-len-to-local',
	'copy len to another local and loop on that',
	'',
	undefined,
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32)
	(local.set 4 (local.get 2))
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`
);
S(
	'guard-inside-extra-pre-stmt',
	'nop between guard and loop',
	'',
	undefined,
	UPDATE.replace('(loop $l', '(nop) (loop $l')
);
S(
	'result-is-tee',
	'return via tee',
	'',
	undefined,
	UPDATE.replace('(local.get 0))', '(local.tee 0 (local.get 0)))')
);
S(
	'nested-block-guard',
	'guard block wrapped in another block',
	'',
	undefined,
	`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
	(block $outer (block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 (i32.xor (local.get 0) (local.get 3)))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1)))))))
	(local.get 0))`
);
S(
	'br-if-extra-in-guard',
	'extra br_if out of the guard before the loop',
	'',
	undefined,
	UPDATE.replace('(loop $l', '(br_if $g (i32.eqz (local.get 0))) (loop $l')
);
runBatch(entries, dir, 'loopstate');
