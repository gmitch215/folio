import binaryen from 'binaryen';
import { mkdirSync, writeFileSync } from 'node:fs';

// the transfer kernel: rewrites `words` i32 words at `offset` in place and returns their sum
const wat = `(module
	(import "env" "memory" (memory 1))
	(func (export "run") (param $offset i32) (param $words i32) (param $rounds i32) (result i32)
		(local $i i32) (local $r i32) (local $x i32) (local $sum i32) (local $addr i32)
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
			(local.set $sum (i32.add (local.get $sum) (local.get $x)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $sum)))`;
const module = binaryen.parseText(wat);
if (!module.validate()) throw new Error('kernel does not validate');
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(new URL('./build/kernel.wasm', import.meta.url), module.emitBinary());
module.dispose();
