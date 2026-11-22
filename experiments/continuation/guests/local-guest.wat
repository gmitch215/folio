;; Guest for the local continuation prototype (L1).
;; Words in the first page: 1024 signal, 2048 saved lcg, 2056 saved steps left, 2064 signal period K.
;; K = 0 disables the signal. The work loop never writes below 65536.
(module
	(import "env" "memory" (memory 1))
	(import "env" "yield" (func $yield))

	;; the LCG and the remaining step count are globals, not locals, so quiesce can read them
	(global $lcg (mut i64) (i64.const 0))
	(global $left (mut i32) (i32.const 0))
	(global (export "__instance_signal") i32 (i32.const 1024))

	(func $run
		(local $k i32)
		(local $j i32)
		(local $m i32)
		(local $region i64)
		(local.set $k (i32.load (i32.const 2064)))
		;; memory minus the first page and one word of slack
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
				;; raise the signal at every K-th step boundary
				(if (local.get $k)
					(then
						(if (i32.and
								(i32.ne (global.get $left) (i32.const 0))
								(i32.eqz (i32.rem_u (global.get $left) (local.get $k))))
							(then (i32.store (i32.const 1024) (i32.const 1))))))

				;; poll
				(if (i32.load (i32.const 1024))
					(then
						(i32.store (i32.const 1024) (i32.const 0))
						(call $yield)))

				(br $steps))))

	;; clears the scratch words so a finished memory does not depend on whether a quiesce ran
	(func $finish
		(i64.store (i32.const 2048) (i64.const 0))
		(i64.store (i32.const 2056) (i64.const 0))
		(i32.store (i32.const 2064) (i32.const 0)))

	(func (export "work") (param $steps i32) (result i64)
		(global.set $lcg (i64.const 2651435461212134099))
		(global.set $left (local.get $steps))
		(call $run)
		(call $finish)
		(global.get $lcg))

	;; stores the state that lives in globals into memory; the caller then checkpoints memory
	(func (export "quiesce") (result i32)
		(i64.store (i32.const 2048) (global.get $lcg))
		(i64.store (i32.const 2056) (i64.extend_i32_u (global.get $left)))
		(i32.const 1))

	(func (export "resume_from_memory") (param $steps_left i32) (result i64)
		(global.set $lcg (i64.load (i32.const 2048)))
		(global.set $left (local.get $steps_left))
		(call $run)
		(call $finish)
		(global.get $lcg))
)
