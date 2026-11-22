;; Guest for the durable continuation prototype. One synchronous export, run(steps).
;; All state lives in globals; the host reads it with get_state/get_steps and sets it with set_state.
;; Word 1024 is the platform signal: run returns early when it is nonzero after a step.
(module
	(import "env" "memory" (memory 512))

	(global $lcg (mut i64) (i64.const 2651435461212134099))
	(global $steps (mut i32) (i32.const 0))
	(global (export "__instance_signal") i32 (i32.const 1024))

	;; one step: 800,000 LCG rounds (about 1 ms of CPU) and 8 scattered 8-byte writes above 64 KiB
	(func $step
		(local $j i32)
		(local $m i32)
		(local $region i64)
		(local.set $j (i32.const 0))
		(loop $mix
			(global.set $lcg
				(i64.add
					(i64.mul (global.get $lcg) (i64.const 6364136223846793005))
					(i64.const 1442695040888963407)))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br_if $mix (i32.lt_u (local.get $j) (i32.const 800000))))
		(local.set $region
			(i64.sub
				(i64.extend_i32_u (i32.shl (memory.size) (i32.const 16)))
				(i64.const 65544)))
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
		(global.set $steps (i32.add (global.get $steps) (i32.const 1))))

	;; returns the steps done by this call; stops early when the signal word is nonzero
	(func (export "run") (param $steps i32) (result i32)
		(local $done i32)
		(block $out
			(loop $next
				(br_if $out (i32.ge_u (local.get $done) (local.get $steps)))
				(call $step)
				(local.set $done (i32.add (local.get $done) (i32.const 1)))
				(br_if $out (i32.load (i32.const 1024)))
				(br $next)))
		(local.get $done))

	(func (export "get_state") (result i64)
		(global.get $lcg))

	(func (export "get_steps") (result i32)
		(global.get $steps))

	(func (export "set_state") (param $lcg i64) (param $steps i32)
		(global.set $lcg (local.get $lcg))
		(global.set $steps (local.get $steps)))
)
