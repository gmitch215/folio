(module
	(memory (export "memory") 1)
	(global (export "__instance_signal") i32 (i32.const 1024))
	(global (export "__instance_terminated") i32 (i32.const 1028))

	;; the 64-bit LCG value lives at 2048 between blocks

	(func (export "burn") (param $blocks i32) (param $poll i32) (result i32)
		(local $b i32)
		(local $i i32)
		(local $x i64)
		(block $done
			(loop $block
				(br_if $done (i32.ge_u (local.get $b) (local.get $blocks)))
				(local.set $x (i64.load (i32.const 2048)))
				(local.set $i (i32.const 0))
				(block $iter
					(loop $step
						(br_if $iter (i32.ge_u (local.get $i) (i32.const 1000000)))
						(local.set $x
							(i64.add
								(i64.mul (local.get $x) (i64.const 6364136223846793005))
								(i64.const 1442695040888963407)))
						(local.set $i (i32.add (local.get $i) (i32.const 1)))
						(br $step)))
				(i64.store (i32.const 2048) (local.get $x))
				(local.set $b (i32.add (local.get $b) (i32.const 1)))
				(if (i32.ne (local.get $poll) (i32.const 0))
					(then
						(if (i32.ne (i32.load (i32.const 1024)) (i32.const 0))
							(then (return (local.get $b))))))
				(br $block)))
		(local.get $blocks))

	(func (export "word") (param $addr i32) (result i32)
		(i32.load (local.get $addr)))

	(func (export "clear") (param $addr i32)
		(i32.store (local.get $addr) (i32.const 0)))

	(func (export "state") (result i64)
		(i64.load (i32.const 2048)))
)
