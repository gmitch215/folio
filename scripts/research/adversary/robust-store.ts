import { timedCertify } from './lib.ts';

// two nested 4000 iteration loops of i64.store; before the analysis caps this took 290 s
timedCertify(`(module
 (memory (export "memory") 2048 2048)
 (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
  (local $i i32) (local $j i32)
  (loop $o
   (local.set $j (i32.const 0))
   (loop $in
    (i64.store (i32.shl (i32.add (i32.mul (local.get $i) (i32.const 4000)) (local.get $j)) (i32.const 3)) (i64.const 1))
    (local.set $j (i32.add (local.get $j) (i32.const 1)))
    (br_if $in (i32.lt_u (local.get $j) (i32.const 4000))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $o (i32.lt_u (local.get $i) (i32.const 4000))))
  (local.get $s)))`);
