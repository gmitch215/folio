import binaryen from 'binaryen';
import type { Consumer } from '../consumer.ts';

// each iteration reads the value the previous one produced, so no two iterations are independent
const text = `(module
 (memory (export "memory") 2)
 (func (export "chain") (param $n i32) (result i32)
  (local $i i32) (local $x i32)
  (local.set $x (i32.const 1))
  (loop $next
   (local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223)))
   (i32.store (i32.and (i32.shl (local.get $i) (i32.const 2)) (i32.const 65532)) (local.get $x))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $next (i32.lt_u (local.get $i) (local.get $n))))
  (local.get $x)))`;
const module = binaryen.parseText(text);
if (!module.validate()) throw new Error('invalid negative control');
const bytes = module.emitBinary();
module.dispose();

const consumer: Consumer = {
	name: 'serial-chain',
	bytes,
	cases: [{ name: 'recurrence-500k', prepare: () => [{ export: 'chain', args: [500_000] }] }]
};
export default consumer;
