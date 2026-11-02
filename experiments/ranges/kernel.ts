import binaryen from 'binaryen';
import { MAX_PAGES, PARTITION, PARTITIONS } from './layout.ts';

const words = PARTITION / 4;
const memory = `(import "env" "memory" (memory 1 ${MAX_PAGES} shared))`;

function emit(wat: string): Uint8Array {
	const module = binaryen.parseText(wat);
	module.setFeatures(binaryen.Features.All);
	if (!module.validate()) throw new Error('module does not validate');
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

/**
 * The partitioned kernel: `main(base, waves, rounds)` rewrites each of four partitions once per
 * wave, each in its own call, and returns the first word of the first partition. It imports its
 * memory so one artifact serves every arena size.
 */
export function kernelSource(): Uint8Array {
	const call = (index: number) =>
		`(call $run (i32.add (local.get $base) (i32.const ${index * PARTITION})) (i32.const ${words}) (local.get $rounds))`;
	return emit(`(module ${memory}
	(func $run (param $offset i32) (param $words i32) (param $rounds i32)
		(local $i i32) (local $r i32) (local $x i32) (local $addr i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $words)))
			(local.set $addr (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 2))))
			(local.set $x (i32.load (local.get $addr)))
			(local.set $r (i32.const 0))
			(block $end (loop $round
				(br_if $end (i32.ge_u (local.get $r) (local.get $rounds)))
				(local.set $x (i32.xor
					(i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223))
					(i32.shr_u (local.get $x) (i32.const 15))))
				(local.set $r (i32.add (local.get $r) (i32.const 1)))
				(br $round)))
			(i32.store (local.get $addr) (local.get $x))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each))))
	(func (export "main") (param $base i32) (param $waves i32) (param $rounds i32) (result i32)
		(local $wave i32) (local $sum i32)
		(loop $next
			${Array.from({ length: PARTITIONS }, (_, index) => call(index)).join(' ')}
			(local.set $sum (i32.add (local.get $sum) (i32.load (local.get $base))))
			(local.set $wave (i32.add (local.get $wave) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $wave) (local.get $waves))))
		(local.get $sum)))`);
}

const chains = [0, 1, 2, 3];

/**
 * Owner-side tools over the same memory: a xorshift64 fill and a 64-bit digest. Both run four
 * independent chains over 32 bytes a step, so lengths are multiples of 32.
 */
export function helperSource(): Uint8Array {
	const states = chains.map((i) => `(local $x${i} i64) (local $h${i} i64)`).join(' ');
	const seeds = chains
		.map(
			(i) =>
				`(local.set $x${i} (i64.or (i64.add (local.get $seed) (i64.const ${(BigInt(i + 1) * 0x9e3779b97f4a7c15n) & 0x7fffffffffffffffn})) (i64.const 1)))`
		)
		.join(' ');
	const steps = chains
		.map(
			(i) => `
			(local.set $x${i} (i64.xor (local.get $x${i}) (i64.shl (local.get $x${i}) (i64.const 13))))
			(local.set $x${i} (i64.xor (local.get $x${i}) (i64.shr_u (local.get $x${i}) (i64.const 7))))
			(local.set $x${i} (i64.xor (local.get $x${i}) (i64.shl (local.get $x${i}) (i64.const 17))))
			(i64.store offset=${i * 8} (local.get $at) (i64.mul (local.get $x${i}) (i64.const 0x2545f4914f6cdd1d)))`
		)
		.join('');
	const mix = (value: string, word: string) =>
		`(i64.mul (i64.rotl (i64.xor ${value} ${word}) (i64.const 5)) (i64.const 0x100000001b3))`;
	const hashes = chains
		.map(
			(i) =>
				`(local.set $h${i} ${mix(`(local.get $h${i})`, `(i64.load offset=${i * 8} (local.get $at))`)})`
		)
		.join(' ');
	return emit(`(module ${memory}
	(func (export "fill") (param $at i32) (param $length i32) (param $seed i64)
		(local $end i32) ${states}
		${seeds}
		(local.set $end (i32.add (local.get $at) (local.get $length)))
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $at) (local.get $end)))
			${steps}
			(local.set $at (i32.add (local.get $at) (i32.const 32)))
			(br $each))))
	(func (export "digest") (param $at i32) (param $length i32) (result i64)
		(local $end i32) ${states}
		${chains.map((i) => `(local.set $h${i} (i64.const ${(0xcbf29ce484222325n + BigInt(i) * 0x10001n) & 0x7fffffffffffffffn}))`).join(' ')}
		(local.set $end (i32.add (local.get $at) (local.get $length)))
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $at) (local.get $end)))
			${hashes}
			(local.set $at (i32.add (local.get $at) (i32.const 32)))
			(br $each)))
		${mix(mix(mix('(local.get $h0)', '(local.get $h1)'), '(local.get $h2)'), '(local.get $h3)')}))`);
}
