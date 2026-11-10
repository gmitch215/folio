import binaryen from 'binaryen';

// the skewed, scan and chase programs: memory lowered to folio imports, then Asyncify
const WAT = `(module
 (import "env" "memory" (memory 1 8192))
 (import "folio" "op" (func $op (param i32) (result i32)))
 (import "folio" "load" (func $load (param i32 i32 i32 i32) (result i32)))
 (import "folio" "store" (func $store (param i32 i32 i32 i32)))
 (func (export "run_trace") (param $n i32) (result i32)
  (local $i i32) (local $o i32) (local $a i32) (local $sum i32)
  (block $end (loop $again
   (br_if $end (i32.ge_u (local.get $i) (local.get $n)))
   (local.set $o (call $op (local.get $i)))
   (local.set $a (i32.shl (i32.shr_u (local.get $o) (i32.const 2)) (i32.const 16)))
   (if (i32.and (local.get $o) (i32.const 3))
    (then (call $store (local.get $a) (local.get $i) (i32.const 128) (i32.const 4)))
    (else (local.set $sum (i32.xor (i32.mul (local.get $sum) (i32.const 31))
      (call $load (local.get $a) (i32.const 128) (i32.const 4) (i32.const 0))))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $again)))
  (local.get $sum))
 (func (export "run_chase") (param $n i32) (param $pages i32) (result i32)
  (local $i i32) (local $p i32) (local $a i32) (local $v i32) (local $sum i32)
  (block $end (loop $again
   (br_if $end (i32.ge_u (local.get $i) (local.get $n)))
   (local.set $a (i32.shl (local.get $p) (i32.const 16)))
   (local.set $v (call $load (local.get $a) (i32.const 128) (i32.const 4) (i32.const 0)))
   (local.set $sum (i32.xor (i32.mul (local.get $sum) (i32.const 31)) (local.get $v)))
   (call $store (local.get $a) (i32.add (local.get $v) (i32.const 1)) (i32.const 128) (i32.const 4))
   (local.set $p (i32.rem_u
     (call $load (local.get $a) (i32.const 132) (i32.const 4) (i32.const 0)) (local.get $pages)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $again)))
  (local.get $sum)))`;

export function buildTraceWasm(): Uint8Array<ArrayBuffer> {
	const m = binaryen.parseText(WAT);
	const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
	m.setFeatures(binaryen.Features.All & ~compact);
	if (!m.validate()) throw new Error('trace module does not validate');
	binaryen.setPassArgument('asyncify-imports', 'folio.load,folio.store');
	m.runPasses(['asyncify']);
	binaryen.setPassArgument('asyncify-imports', null);
	const bytes = Uint8Array.from(m.emitBinary());
	m.dispose();
	return bytes;
}
