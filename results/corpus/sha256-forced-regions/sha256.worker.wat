(module
 (type $0 (func (param i32 i32)))
 (type $1 (func (param i32)))
 (type $2 (func))
 (type $3 (func (param i32 i32 i32)))
 (type $4 (func (param i32 i32 i32 i32)))
 (type $5 (func (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)))
 (type $6 (func (param i32 i64)))
 (type $7 (func (param i32 i32 i32) (result i32)))
 (type $8 (func (result i32)))
 (import "env" "memory" (memory $mimport$0 128 1024 shared))
 (export "corpus_output" (func $corpus_output))
 (export "initialize" (func $initialize))
 (export "__folio_region_0" (func $__folio_region_0))
 (export "__folio_region_1" (func $__folio_region_1))
 (export "__folio_region_2" (func $__folio_region_2))
 (export "__folio_region_3" (func $__folio_region_3))
 (export "__folio_region_4" (func $__folio_region_4))
 (export "__folio_region_5" (func $__folio_region_5))
 (export "__folio_region_6" (func $__folio_region_6))
 (export "__folio_region_7" (func $__folio_region_7))
 (export "__folio_region_8" (func $__folio_region_8))
 (export "__folio_region_9" (func $__folio_region_9))
 (export "__folio_region_10" (func $__folio_region_10))
 (export "__folio_region_11" (func $__folio_region_11))
 (export "__folio_region_12" (func $__folio_region_12))
 (export "__folio_region_13" (func $__folio_region_13))
 (export "__folio_region_14" (func $__folio_region_14))
 (export "__folio_region_15" (func $__folio_region_15))
 (export "__folio_region_16" (func $__folio_region_16))
 (func $__wasm_init_memory (type $2)
  (memory.fill
   (i32.const 65792)
   (i32.const 0)
   (i32.const 4784272)
  )
 )
 (func $memset (type $7) (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (block $block
   (br_if $block
    (i32.eqz
     (local.get $2)
    )
   )
   (local.set $3
    (i32.and
     (local.get $2)
     (i32.const 7)
    )
   )
   (local.set $4
    (i32.const 0)
   )
   (block $block1
    (br_if $block1
     (i32.lt_u
      (local.get $2)
      (i32.const 8)
     )
    )
    (local.set $5
     (i32.and
      (local.get $2)
      (i32.const -8)
     )
    )
    (local.set $4
     (i32.const 0)
    )
    (loop $label
     (i32.store8
      (local.tee $2
       (i32.add
        (local.get $0)
        (local.get $4)
       )
      )
      (local.get $1)
     )
     (call $__folio_inline_0
      (local.get $1)
      (local.get $2)
     )
     (br_if $label
      (i32.ne
       (local.get $5)
       (local.tee $4
        (i32.add
         (local.get $4)
         (i32.const 8)
        )
       )
      )
     )
    )
    (br_if $block
     (i32.eqz
      (local.get $3)
     )
    )
   )
   (local.set $2
    (i32.add
     (local.get $0)
     (local.get $4)
    )
   )
   (loop $label1
    (i32.store8
     (local.get $2)
     (local.get $1)
    )
    (local.set $2
     (i32.add
      (local.get $2)
      (i32.const 1)
     )
    )
    (br_if $label1
     (local.tee $3
      (i32.add
       (local.get $3)
       (i32.const -1)
      )
     )
    )
   )
  )
  (local.get $0)
 )
 (func $corpus_reset (type $2)
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (i32.store offset=65792
   (i32.const 0)
   (i32.const 0)
  )
  (local.set $0
   (i32.const -4194304)
  )
  (loop $label
   (call $__folio_inline_1
    (local.get $0)
   )
   (br_if $label
    (local.tee $0
     (i32.add
      (local.get $0)
      (i32.const 8)
     )
    )
   )
  )
  (local.set $0
   (i32.const -262144)
  )
  (loop $label1
   (call $__folio_inline_2
    (local.get $0)
   )
   (br_if $label1
    (local.tee $0
     (i32.add
      (local.get $0)
      (i32.const 8)
     )
    )
   )
  )
  (local.set $0
   (i32.const -262144)
  )
  (loop $label2
   (call $__folio_inline_3
    (local.get $0)
   )
   (br_if $label2
    (local.tee $0
     (i32.add
      (local.get $0)
      (i32.const 8)
     )
    )
   )
  )
  (local.set $1
   (i32.const 0)
  )
  (i32.store offset=4784400
   (i32.const 0)
   (i32.const 0)
  )
  (local.set $0
   (i32.const -65536)
  )
  (local.set $2
   (i32.const 0)
  )
  (loop $label3
   (call $__folio_inline_4
    (local.get $0)
    (local.get $1)
    (local.get $2)
    (local.get $3)
   )
   (local.set $1
    (i32.add
     (local.get $1)
     (i32.const 52)
    )
   )
   (local.set $2
    (i32.add
     (local.get $2)
     (i32.const 4)
    )
   )
   (br_if $label3
    (local.tee $0
     (i32.add
      (local.get $0)
      (i32.const 4)
     )
    )
   )
  )
 )
 (func $corpus_output (type $8) (result i32)
  (i32.const 4260112)
 )
 (func $initialize (type $2)
  (call $corpus_reset)
  (call $sha256_init
   (i32.const 4849952)
  )
 )
 (func $sha256_init (type $1) (param $0 i32)
  (i64.store offset=104
   (local.get $0)
   (i64.const 6620516960021240235)
  )
  (i64.store offset=96
   (local.get $0)
   (i64.const -7276294671082564993)
  )
  (i64.store offset=88
   (local.get $0)
   (i64.const -6534734903820487822)
  )
  (i64.store offset=80
   (local.get $0)
   (i64.const -4942790177982912921)
  )
  (i64.store offset=72
   (local.get $0)
   (i64.const 0)
  )
  (i32.store offset=64
   (local.get $0)
   (i32.const 0)
  )
 )
 (func $__folio_inline_0 (type $0) (param $0 i32) (param $1 i32)
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 7)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 6)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 5)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 4)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 3)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 2)
   )
   (local.get $0)
  )
  (i32.store8
   (i32.add
    (local.get $1)
    (i32.const 1)
   )
   (local.get $0)
  )
 )
 (func $__folio_inline_1 (type $1) (param $0 i32)
  (i64.store
   (i32.add
    (local.get $0)
    (i32.const 4260112)
   )
   (i64.const 0)
  )
 )
 (func $__folio_inline_2 (type $1) (param $0 i32)
  (i64.store
   (i32.add
    (local.get $0)
    (i32.const 4522256)
   )
   (i64.const 0)
  )
 )
 (func $__folio_inline_3 (type $1) (param $0 i32)
  (i64.store
   (i32.add
    (local.get $0)
    (i32.const 4784400)
   )
   (i64.const 0)
  )
 )
 (func $__folio_inline_4 (type $4) (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32)
  (i32.store8
   (i32.add
    (local.get $0)
    (i32.const 4849952)
   )
   (local.tee $3
    (i32.add
     (local.get $1)
     (i32.shr_u
      (local.get $2)
      (i32.const 7)
     )
    )
   )
  )
  (i32.store8
   (i32.add
    (local.get $0)
    (i32.const 4849955)
   )
   (i32.add
    (local.get $3)
    (i32.const 39)
   )
  )
  (i32.store8
   (i32.add
    (local.get $0)
    (i32.const 4849954)
   )
   (i32.add
    (local.get $3)
    (i32.const 26)
   )
  )
  (i32.store8
   (i32.add
    (local.get $0)
    (i32.const 4849953)
   )
   (i32.add
    (local.get $3)
    (i32.const 13)
   )
  )
 )
 (func $__folio_inline_5 (type $5) (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (param $8 i32) (param $9 i32) (param $10 i32) (param $11 i32) (param $12 i32) (param $13 i32) (param $14 i32) (param $15 i32) (param $16 i32)
  (i32.store offset=108
   (local.get $0)
   (i32.add
    (local.get $16)
    (local.get $7)
   )
  )
  (i32.store offset=104
   (local.get $0)
   (i32.add
    (local.get $15)
    (local.get $8)
   )
  )
  (i32.store offset=100
   (local.get $0)
   (i32.add
    (local.get $3)
    (local.get $9)
   )
  )
  (i32.store offset=96
   (local.get $0)
   (i32.add
    (local.get $11)
    (local.get $10)
   )
  )
  (i32.store offset=92
   (local.get $0)
   (i32.add
    (local.get $14)
    (local.get $12)
   )
  )
  (i32.store offset=88
   (local.get $0)
   (i32.add
    (local.get $1)
    (local.get $13)
   )
  )
  (i32.store offset=84
   (local.get $0)
   (i32.add
    (local.get $2)
    (local.get $6)
   )
  )
  (i32.store offset=80
   (local.get $0)
   (i32.add
    (local.get $5)
    (local.get $4)
   )
  )
 )
 (func $__folio_inline_6 (type $1) (param $0 i32)
  (i32.store offset=64
   (local.get $0)
   (i32.const 0)
  )
  (i64.store offset=72
   (local.get $0)
   (i64.add
    (i64.load offset=72
     (local.get $0)
    )
    (i64.const 512)
   )
  )
 )
 (func $__folio_inline_7 (type $3) (param $0 i32) (param $1 i32) (param $2 i32)
  (i32.store8
   (i32.add
    (local.get $0)
    (local.get $2)
   )
   (i32.load8_u
    (local.get $1)
   )
  )
 )
 (func $__folio_inline_8 (type $0) (param $0 i32) (param $1 i32)
  (i32.store8
   (i32.add
    (local.get $0)
    (local.get $1)
   )
   (i32.const 0)
  )
 )
 (func $__folio_inline_9 (type $0) (param $0 i32) (param $1 i32)
  (i64.store align=1
   (i32.add
    (i32.add
     (local.get $1)
     (local.get $0)
    )
    (i32.const 1)
   )
   (i64.const 0)
  )
 )
 (func $__folio_inline_10 (type $0) (param $0 i32) (param $1 i32)
  (i32.store8
   (i32.add
    (local.get $0)
    (local.get $1)
   )
   (i32.const 0)
  )
 )
 (func $__folio_inline_11 (type $0) (param $0 i32) (param $1 i32)
  (i64.store align=1
   (i32.add
    (local.get $1)
    (local.get $0)
   )
   (i64.const 0)
  )
 )
 (func $__folio_inline_12 (type $6) (param $0 i32) (param $1 i64)
  (i64.store offset=72
   (local.get $0)
   (local.tee $1
    (i64.add
     (i64.load offset=72
      (local.get $0)
     )
     (i64.extend_i32_u
      (i32.shl
       (i32.load offset=64
        (local.get $0)
       )
       (i32.const 3)
      )
     )
    )
   )
  )
  (i64.store8 offset=63
   (local.get $0)
   (local.get $1)
  )
  (i64.store8 offset=62
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 8)
   )
  )
  (i64.store8 offset=61
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 16)
   )
  )
  (i64.store8 offset=60
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 24)
   )
  )
  (i64.store8 offset=59
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 32)
   )
  )
  (i64.store8 offset=58
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 40)
   )
  )
  (i64.store8 offset=57
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 48)
   )
  )
  (i64.store8 offset=56
   (local.get $0)
   (i64.shr_u
    (local.get $1)
    (i64.const 56)
   )
  )
 )
 (func $__folio_inline_13 (type $0) (param $0 i32) (param $1 i32)
  (i32.store8
   (local.get $1)
   (i32.load8_u offset=83
    (local.get $0)
   )
  )
  (i32.store8 offset=4
   (local.get $1)
   (i32.load8_u offset=87
    (local.get $0)
   )
  )
  (i32.store8 offset=8
   (local.get $1)
   (i32.load8_u offset=91
    (local.get $0)
   )
  )
  (i32.store8 offset=12
   (local.get $1)
   (i32.load8_u offset=95
    (local.get $0)
   )
  )
  (i32.store8 offset=16
   (local.get $1)
   (i32.load8_u offset=99
    (local.get $0)
   )
  )
  (i32.store8 offset=20
   (local.get $1)
   (i32.load8_u offset=103
    (local.get $0)
   )
  )
  (i32.store8 offset=24
   (local.get $1)
   (i32.load8_u offset=107
    (local.get $0)
   )
  )
  (i32.store8 offset=28
   (local.get $1)
   (i32.load8_u offset=111
    (local.get $0)
   )
  )
  (i32.store8 offset=1
   (local.get $1)
   (i32.load16_u offset=82
    (local.get $0)
   )
  )
  (i32.store8 offset=5
   (local.get $1)
   (i32.load16_u offset=86
    (local.get $0)
   )
  )
  (i32.store8 offset=9
   (local.get $1)
   (i32.load16_u offset=90
    (local.get $0)
   )
  )
  (i32.store8 offset=13
   (local.get $1)
   (i32.load16_u offset=94
    (local.get $0)
   )
  )
  (i32.store8 offset=17
   (local.get $1)
   (i32.load16_u offset=98
    (local.get $0)
   )
  )
  (i32.store8 offset=21
   (local.get $1)
   (i32.load16_u offset=102
    (local.get $0)
   )
  )
  (i32.store8 offset=25
   (local.get $1)
   (i32.load16_u offset=106
    (local.get $0)
   )
  )
  (i32.store8 offset=29
   (local.get $1)
   (i32.load16_u offset=110
    (local.get $0)
   )
  )
  (i32.store8 offset=2
   (local.get $1)
   (i32.shr_u
    (i32.load offset=80
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=6
   (local.get $1)
   (i32.shr_u
    (i32.load offset=84
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=10
   (local.get $1)
   (i32.shr_u
    (i32.load offset=88
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=14
   (local.get $1)
   (i32.shr_u
    (i32.load offset=92
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=18
   (local.get $1)
   (i32.shr_u
    (i32.load offset=96
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=22
   (local.get $1)
   (i32.shr_u
    (i32.load offset=100
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=26
   (local.get $1)
   (i32.shr_u
    (i32.load offset=104
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=30
   (local.get $1)
   (i32.shr_u
    (i32.load offset=108
     (local.get $0)
    )
    (i32.const 8)
   )
  )
  (i32.store8 offset=3
   (local.get $1)
   (i32.load offset=80
    (local.get $0)
   )
  )
  (i32.store8 offset=7
   (local.get $1)
   (i32.load offset=84
    (local.get $0)
   )
  )
  (i32.store8 offset=11
   (local.get $1)
   (i32.load offset=88
    (local.get $0)
   )
  )
  (i32.store8 offset=15
   (local.get $1)
   (i32.load offset=92
    (local.get $0)
   )
  )
  (i32.store8 offset=19
   (local.get $1)
   (i32.load offset=96
    (local.get $0)
   )
  )
  (i32.store8 offset=23
   (local.get $1)
   (i32.load offset=100
    (local.get $0)
   )
  )
  (i32.store8 offset=27
   (local.get $1)
   (i32.load offset=104
    (local.get $0)
   )
  )
  (i32.store8 offset=31
   (local.get $1)
   (i32.load offset=108
    (local.get $0)
   )
  )
 )
 (func $__folio_region_0 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_0
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_1 (type $1) (param $0 i32)
  (call $__folio_inline_1
   (local.get $0)
  )
 )
 (func $__folio_region_2 (type $1) (param $0 i32)
  (call $__folio_inline_2
   (local.get $0)
  )
 )
 (func $__folio_region_3 (type $1) (param $0 i32)
  (call $__folio_inline_3
   (local.get $0)
  )
 )
 (func $__folio_region_4 (type $4) (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32)
  (call $__folio_inline_4
   (local.get $0)
   (local.get $1)
   (local.get $2)
   (local.get $3)
  )
 )
 (func $__folio_region_5 (type $2)
  (call $corpus_reset)
 )
 (func $__folio_region_6 (type $1) (param $0 i32)
  (call $sha256_init
   (local.get $0)
  )
 )
 (func $__folio_region_7 (type $5) (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32) (param $6 i32) (param $7 i32) (param $8 i32) (param $9 i32) (param $10 i32) (param $11 i32) (param $12 i32) (param $13 i32) (param $14 i32) (param $15 i32) (param $16 i32)
  (call $__folio_inline_5
   (local.get $0)
   (local.get $1)
   (local.get $2)
   (local.get $3)
   (local.get $4)
   (local.get $5)
   (local.get $6)
   (local.get $7)
   (local.get $8)
   (local.get $9)
   (local.get $10)
   (local.get $11)
   (local.get $12)
   (local.get $13)
   (local.get $14)
   (local.get $15)
   (local.get $16)
  )
 )
 (func $__folio_region_8 (type $3) (param $0 i32) (param $1 i32) (param $2 i32)
  (call $__folio_inline_7
   (local.get $0)
   (local.get $1)
   (local.get $2)
  )
 )
 (func $__folio_region_9 (type $1) (param $0 i32)
  (call $__folio_inline_6
   (local.get $0)
  )
 )
 (func $__folio_region_10 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_8
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_11 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_9
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_12 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_10
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_13 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_11
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_14 (type $3) (param $0 i32) (param $1 i32) (param $2 i32)
  (drop
   (call $memset
    (local.get $0)
    (local.get $1)
    (local.get $2)
   )
  )
 )
 (func $__folio_region_15 (type $6) (param $0 i32) (param $1 i64)
  (call $__folio_inline_12
   (local.get $0)
   (local.get $1)
  )
 )
 (func $__folio_region_16 (type $0) (param $0 i32) (param $1 i32)
  (call $__folio_inline_13
   (local.get $0)
   (local.get $1)
  )
 )
)
