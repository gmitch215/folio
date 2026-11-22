(module
	(import "env" "yield" (func $yield))
	(memory (export "memory") 1)
	(global (export "__instance_signal") i32 (i32.const 1024))
	(global (export "__instance_terminated") i32 (i32.const 1028))

	;; the LCG value stays in a local; the block count is published at 2056 for the host

	(func (export "run") (param $blocks i32) (param $every i32) (result i64)
		(local $b i32)
		(local $i i32)
		(local $x i64)
		(local $due i32)
		(block $done
			(loop $block
				(br_if $done (i32.ge_u (local.get $b) (local.get $blocks)))
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
				(local.set $b (i32.add (local.get $b) (i32.const 1)))
				(if (i32.lt_u (local.get $b) (local.get $blocks))
					(then
						(i32.store (i32.const 2056) (local.get $b))
						(local.set $due (i32.const 0))
						(if (i32.gt_u (local.get $every) (i32.const 0))
							(then
								(if (i32.eqz (i32.rem_u (local.get $b) (local.get $every)))
									(then (local.set $due (i32.const 1))))))
						(if (i32.ne (i32.load (i32.const 1024)) (i32.const 0))
							(then
								(i32.store (i32.const 1024) (i32.const 0))
								(local.set $due (i32.const 1))))
						(if (local.get $due)
							(then (call $yield)))))
				(br $block)))
		(i32.store (i32.const 2056) (local.get $b))
		(local.get $x))
)
