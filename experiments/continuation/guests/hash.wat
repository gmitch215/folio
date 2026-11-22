;; Page hash for the checkpoint. Reads the guest memory ($g) and writes one 64-bit hash per
;; 64 KiB page into its own memory ($h, word p at byte 8p). A second memory keeps the hash
;; table out of the guest's memory, so the guest's SHA-256 is the same with or without hashing.
;; Multi-memory: build with wat2wasm --enable-multi-memory. Change detector, not a security hash.
(module
	(import "env" "memory" (memory $g 1))
	(memory $h (export "hashes") 1)

	(func (export "hashPages") (param $first i32) (param $count i32)
		(local $p i32)
		(local $end i32)
		(local $base i32)
		(local $i i32)
		(local $h i64)
		(local.set $end (i32.add (local.get $first) (local.get $count)))
		(local.set $p (local.get $first))
		(block $pages_done
			(loop $pages
				(br_if $pages_done (i32.ge_u (local.get $p) (local.get $end)))
				(local.set $base (i32.shl (local.get $p) (i32.const 16)))
				(local.set $h (i64.const 0x243F6A8885A308D3))
				(local.set $i (i32.const 0))
				(loop $words
					(local.set $h
						(i64.mul
							(i64.xor (local.get $h) (i64.load $g (i32.add (local.get $base) (local.get $i))))
							(i64.const 0x9E3779B97F4A7C15)))
					(local.set $h (i64.xor (local.get $h) (i64.shr_u (local.get $h) (i64.const 32))))
					(local.set $i (i32.add (local.get $i) (i32.const 8)))
					(br_if $words (i32.lt_u (local.get $i) (i32.const 65536))))
				(i64.store $h (i32.shl (local.get $p) (i32.const 3)) (local.get $h))
				(local.set $p (i32.add (local.get $p) (i32.const 1)))
				(br $pages))))
)
