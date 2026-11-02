import binaryen from 'binaryen';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SEED } from './plan.ts';

// a linear congruential loop with no memory traffic; the result keeps the loop from being removed
const wat = `(module
	(func (export "run") (param $rounds i32) (result i32)
		(local $i i32) (local $x i32)
		(local.set $x (i32.const ${SEED}))
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $rounds)))
			(local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $x)))`;
const module = binaryen.parseText(wat);
if (!module.validate()) throw new Error('kernel does not validate');
const root = new URL('./build/', import.meta.url);
mkdirSync(root, { recursive: true });
writeFileSync(new URL('kernel.wasm', root), module.emitBinary());
module.dispose();
