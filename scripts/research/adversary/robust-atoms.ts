import { timedCertify } from './lib.ts';

// every inner iteration interns a new comparison atom (the constant differs) and nothing is stored;
// before the analysis caps this took 368 s
timedCertify(`(module
 (memory (export "memory") 32 512)
 (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
  (local $i i32) (local $j i32)
  (loop $o
   (local.set $j (i32.const 0))
   (loop $in
    (drop (i32.lt_u
      (i32.xor (i32.load8_u (local.get $p)) (i32.add (i32.mul (local.get $i) (i32.const 4000)) (local.get $j)))
      (i32.load8_u offset=1 (local.get $p))))
    (local.set $j (i32.add (local.get $j) (i32.const 1)))
    (br_if $in (i32.lt_u (local.get $j) (i32.const 4000))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $o (i32.lt_u (local.get $i) (i32.const 4000))))
  (local.get $s)))`);
