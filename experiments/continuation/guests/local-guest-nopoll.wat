;; guest.wat with the signal source and the poll removed, for the poll-tax comparison (run 4).
(module
	(import "env" "memory" (memory 1))

	(global $lcg (mut i64) (i64.const 0))
	(global $left (mut i32) (i32.const 0))

	(func $run
		(local $j i32)
		(local $m i32)
		(local $region i64)
		(local.set $region
			(i64.sub
				(i64.extend_i32_u (i32.shl (memory.size) (i32.const 16)))
				(i64.const 65544)))
		(block $done
			(loop $steps
				(br_if $done (i32.eqz (global.get $left)))

				(local.set $j (i32.const 0))
				(loop $mix
					(global.set $lcg
						(i64.add
							(i64.mul (global.get $lcg) (i64.const 6364136223846793005))
							(i64.const 1442695040888963407)))
					(local.set $j (i32.add (local.get $j) (i32.const 1)))
					(br_if $mix (i32.lt_u (local.get $j) (i32.const 4096))))

				(local.set $m (i32.const 0))
				(loop $writes
					(global.set $lcg
						(i64.add
							(i64.mul (global.get $lcg) (i64.const 6364136223846793005))
							(i64.const 1442695040888963407)))
					(i64.store
						(i32.wrap_i64
							(i64.add
								(i64.const 65536)
								(i64.and
									(i64.rem_u (i64.shr_u (global.get $lcg) (i64.const 16)) (local.get $region))
									(i64.const -8))))
						(global.get $lcg))
					(local.set $m (i32.add (local.get $m) (i32.const 1)))
					(br_if $writes (i32.lt_u (local.get $m) (i32.const 8))))

				(global.set $left (i32.sub (global.get $left) (i32.const 1)))
				(br $steps))))

	(func (export "work") (param $steps i32) (result i64)
		(global.set $lcg (i64.const 2651435461212134099))
		(global.set $left (local.get $steps))
		(call $run)
		(global.get $lcg))
)
