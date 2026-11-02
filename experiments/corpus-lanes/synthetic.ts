import binaryen from 'binaryen';

// a frame-free driver of the same shape as the corpus ones: one(rec, out) hashes rec.len bytes
// at rec.in into out[0]; bulk makes one call per record, bulk_chunks makes k records per call
export function syntheticSource(): Uint8Array {
	const module = binaryen.parseText(`(module
	(import "env" "memory" (memory 1 65536))
	(func $one (param $r i32) (param $out i32)
		(local $p i32) (local $end i32) (local $h i32)
		(local.set $p (i32.load (local.get $r)))
		(local.set $end (i32.add (local.get $p) (i32.load offset=4 (local.get $r))))
		(local.set $h (i32.const 5381))
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $p) (local.get $end)))
			(local.set $h (i32.add (i32.mul (local.get $h) (i32.const 33)) (i32.load8_u (local.get $p))))
			(local.set $p (i32.add (local.get $p) (i32.const 1)))
			(br $each)))
		(i32.store (local.get $out) (local.get $h)))
	(func $chunk (param $t i32) (param $n i32) (param $out i32)
		(local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(call $one
				(i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))
				(i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 64))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each))))
	(func (export "bulk") (param $t i32) (param $n i32) (param $out i32) (result i32)
		(local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(call $one
				(i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))
				(i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 64))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $n))
	(func (export "bulk_chunks") (param $t i32) (param $n i32) (param $out i32) (param $k i32) (result i32)
		(local $i i32) (local $c i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $c (i32.sub (local.get $n) (local.get $i)))
			(if (i32.gt_u (local.get $c) (local.get $k)) (then (local.set $c (local.get $k))))
			(call $chunk
				(i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))
				(local.get $c)
				(i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 64))))
			(local.set $i (i32.add (local.get $i) (local.get $k)))
			(br $each)))
		(local.get $n)))`);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}
