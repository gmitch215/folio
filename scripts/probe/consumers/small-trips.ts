import binaryen from 'binaryen';
import type { Consumer } from '../consumer.ts';

// a compute loop whose bound is a parameter, so static admission cannot see how small the real trip count is
const text = `(module
 (import "env" "memory" (memory 2049 8192 shared))
 (func $kernel (param $at i32) (param $rounds i32) (local $i i32) (local $v i32)
  (local.set $v (i32.load (local.get $at)))
  (loop $l
   (local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 13))))
   (local.set $v (i32.xor (local.get $v) (i32.shr_u (local.get $v) (i32.const 17))))
   (local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 5))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.ne (local.get $i) (local.get $rounds))))
  (i32.store (local.get $at) (local.get $v)))
 (func (export "lone") (param $count i32) (param $rounds i32) (result i32) (local $j i32) (local $sum i32)
  (loop $o
   (call $kernel (i32.add (i32.const 1024) (i32.shl (local.get $j) (i32.const 2))) (local.get $rounds))
   (local.set $sum (i32.add (local.get $sum)
    (i32.load (i32.add (i32.const 1024) (i32.shl (local.get $j) (i32.const 2))))))
   (local.set $j (i32.add (local.get $j) (i32.const 1)))
   (br_if $o (i32.lt_u (local.get $j) (local.get $count))))
  (local.get $sum))
 (func (export "batch") (param $count i32) (param $rounds i32) (local $j i32)
  (loop $o
   (call $kernel (i32.add (i32.const 1024) (i32.shl (local.get $j) (i32.const 2))) (local.get $rounds))
   (local.set $j (i32.add (local.get $j) (i32.const 1)))
   (br_if $o (i32.lt_u (local.get $j) (local.get $count))))))`;
const module = binaryen.parseText(text);
module.setFeatures(binaryen.Features.All);
if (!module.validate()) throw new Error('invalid small-trips module');
const bytes = module.emitBinary();
module.dispose();

const seed = (api: { memory: WebAssembly.Memory }, count: number) => {
	const words = new Uint32Array(api.memory.buffer, 1024, count);
	for (let i = 0; i < count; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
};
// below the default threshold the dispatch check keeps regions at the owner; at 40000 rounds they sit just above it
const shapes: [string, number, number][] = [
	['lone', 5000, 2000],
	['batch', 5000, 2000],
	['lone', 1000, 40_000],
	['batch', 1000, 40_000]
];
const consumer: Consumer = {
	name: 'small-trips',
	bytes,
	imports() {
		const memory = new WebAssembly.Memory({ initial: 2049, maximum: 8192, shared: true });
		return { memory, imports: { env: { memory } } };
	},
	cases: shapes.map(([entry, count, rounds]) => ({
		name: `${entry}-${count}x${rounds}`,
		prepare(api) {
			seed(api, count);
			return [{ export: entry, args: [count, rounds] }];
		}
	}))
};
export default consumer;
