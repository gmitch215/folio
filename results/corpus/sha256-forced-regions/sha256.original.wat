(module $sha256.wasm
 (type $0 (func))
 (type $1 (func (result i32)))
 (type $2 (func (param i32 i32)))
 (type $3 (func (param i32 i32 i32) (result i32)))
 (type $4 (func (param i32)))
 (type $5 (func (param i32 i32 i32)))
 (import "env" "memory" (memory $mimport$0 128 1024))
 (global $__stack_pointer (mut i32) (i32.const 65536))
 (data $.rodata (i32.const 65536) "\98/\8aB\91D7q\cf\fb\c0\b5\a5\db\b5\e9[\c2V9\f1\11\f1Y\a4\82?\92\d5^\1c\ab\98\aa\07\d8\01[\83\12\be\851$\c3}\0cUt]\ber\fe\b1\de\80\a7\06\dc\9bt\f1\9b\c1\c1i\9b\e4\86G\be\ef\c6\9d\c1\0f\cc\a1\0c$o,\e9-\aa\84tJ\dc\a9\b0\\\da\88\f9vRQ>\98m\c61\a8\c8\'\03\b0\c7\7fY\bf\f3\0b\e0\c6G\91\a7\d5Qc\ca\06g))\14\85\n\b7\'8!\1b.\fcm,M\13\r8STs\ne\bb\njv.\c9\c2\81\85,r\92\a1\e8\bf\a2Kf\1a\a8p\8bK\c2\a3Ql\c7\19\e8\92\d1$\06\99\d6\855\0e\f4p\a0j\10\16\c1\a4\19\08l7\1eLwH\'\b5\bc\b04\b3\0c\1c9J\aa\d8NO\ca\9c[\f3o.h\ee\82\8ftoc\a5x\14x\c8\84\08\02\c7\8c\fa\ff\be\90\eblP\a4\f7\a3\f9\be\f2xq\c6")
 (export "memory" (memory $mimport$0))
 (export "corpus_output" (func $corpus_output))
 (export "initialize" (func $initialize))
 (export "entry" (func $entry))
 (start $__wasm_init_memory)
 (func $__wasm_init_memory (type $0)
  (memory.fill
   (i32.const 65792)
   (i32.const 0)
   (i32.const 4784272)
  )
 )
 (func $memset (type $3) (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
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
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 7)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 6)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 5)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 4)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 3)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 2)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 1)
      )
      (local.get $1)
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
 (func $corpus_reset (type $0)
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
   (i64.store
    (i32.add
     (local.get $0)
     (i32.const 4260112)
    )
    (i64.const 0)
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
   (i64.store
    (i32.add
     (local.get $0)
     (i32.const 4522256)
    )
    (i64.const 0)
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
   (i64.store
    (i32.add
     (local.get $0)
     (i32.const 4784400)
    )
    (i64.const 0)
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
 (func $corpus_output (type $1) (result i32)
  (i32.const 4260112)
 )
 (func $initialize (type $0)
  (call $corpus_reset)
  (call $sha256_init
   (i32.const 4849952)
  )
 )
 (func $entry (type $1) (result i32)
  (call $sha256_update
   (i32.const 4849952)
   (i32.const 4784416)
   (i32.const 65536)
  )
  (call $sha256_final
   (i32.const 4849952)
   (i32.const 4260112)
  )
  (i32.const 32)
 )
 (func $sha256_transform (type $2) (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (global.set $__stack_pointer
   (local.tee $2
    (i32.sub
     (global.get $__stack_pointer)
     (i32.const 256)
    )
   )
  )
  (local.set $3
   (i32.const 0)
  )
  (loop $label
   (i32.store
    (i32.add
     (local.get $2)
     (local.get $3)
    )
    (i32.xor
     (i32.shr_u
      (i32.and
       (i32.xor
        (local.tee $4
         (i32.load align=1
          (i32.add
           (local.get $1)
           (local.get $3)
          )
         )
        )
        (i32.rotr
         (local.get $4)
         (i32.const 16)
        )
       )
       (i32.const -16711936)
      )
      (i32.const 8)
     )
     (i32.rotr
      (local.get $4)
      (i32.const 8)
     )
    )
   )
   (br_if $label
    (i32.ne
     (local.tee $3
      (i32.add
       (local.get $3)
       (i32.const 4)
      )
     )
     (i32.const 64)
    )
   )
  )
  (local.set $4
   (i32.const 0)
  )
  (loop $label1
   (i32.store
    (i32.add
     (local.tee $3
      (i32.add
       (local.get $2)
       (local.get $4)
      )
     )
     (i32.const 64)
    )
    (i32.add
     (i32.add
      (i32.add
       (i32.xor
        (i32.xor
         (i32.rotl
          (local.tee $1
           (i32.load
            (i32.add
             (local.get $3)
             (i32.const 56)
            )
           )
          )
          (i32.const 15)
         )
         (i32.rotl
          (local.get $1)
          (i32.const 13)
         )
        )
        (i32.shr_u
         (local.get $1)
         (i32.const 10)
        )
       )
       (i32.load
        (i32.add
         (local.get $3)
         (i32.const 36)
        )
       )
      )
      (i32.load
       (local.get $3)
      )
     )
     (i32.xor
      (i32.xor
       (i32.rotl
        (local.tee $3
         (i32.load
          (i32.add
           (local.get $3)
           (i32.const 4)
          )
         )
        )
        (i32.const 25)
       )
       (i32.rotl
        (local.get $3)
        (i32.const 14)
       )
      )
      (i32.shr_u
       (local.get $3)
       (i32.const 3)
      )
     )
    )
   )
   (br_if $label1
    (i32.ne
     (local.tee $4
      (i32.add
       (local.get $4)
       (i32.const 4)
      )
     )
     (i32.const 192)
    )
   )
  )
  (local.set $5
   (i32.const 0)
  )
  (local.set $7
   (local.tee $6
    (i32.load offset=80
     (local.get $0)
    )
   )
  )
  (local.set $3
   (local.tee $8
    (i32.load offset=84
     (local.get $0)
    )
   )
  )
  (local.set $10
   (local.tee $9
    (i32.load offset=108
     (local.get $0)
    )
   )
  )
  (local.set $12
   (local.tee $11
    (i32.load offset=104
     (local.get $0)
    )
   )
  )
  (local.set $14
   (local.tee $13
    (i32.load offset=100
     (local.get $0)
    )
   )
  )
  (local.set $16
   (local.tee $15
    (i32.load offset=96
     (local.get $0)
    )
   )
  )
  (local.set $18
   (local.tee $17
    (i32.load offset=92
     (local.get $0)
    )
   )
  )
  (local.set $1
   (local.tee $19
    (i32.load offset=88
     (local.get $0)
    )
   )
  )
  (loop $label2
   (local.set $20
    (local.get $1)
   )
   (local.set $1
    (local.get $3)
   )
   (local.set $7
    (i32.add
     (i32.add
      (i32.xor
       (i32.xor
        (i32.rotl
         (local.tee $3
          (local.get $7)
         )
         (i32.const 30)
        )
        (i32.rotl
         (local.get $3)
         (i32.const 19)
        )
       )
       (i32.rotl
        (local.get $3)
        (i32.const 10)
       )
      )
      (i32.xor
       (i32.and
        (local.get $3)
        (i32.xor
         (local.get $1)
         (local.get $20)
        )
       )
       (i32.and
        (local.get $1)
        (local.get $20)
       )
      )
     )
     (local.tee $16
      (i32.add
       (i32.add
        (i32.add
         (i32.add
          (local.get $10)
          (i32.xor
           (i32.xor
            (i32.rotl
             (local.tee $4
              (local.get $16)
             )
             (i32.const 26)
            )
            (i32.rotl
             (local.get $4)
             (i32.const 21)
            )
           )
           (i32.rotl
            (local.get $4)
            (i32.const 7)
           )
          )
         )
         (i32.xor
          (i32.and
           (i32.xor
            (local.tee $21
             (local.get $14)
            )
            (local.tee $22
             (local.get $12)
            )
           )
           (local.get $4)
          )
          (local.get $22)
         )
        )
        (i32.load
         (i32.add
          (local.get $5)
          (i32.const 65536)
         )
        )
       )
       (i32.load
        (i32.add
         (local.get $2)
         (local.get $5)
        )
       )
      )
     )
    )
   )
   (local.set $16
    (i32.add
     (local.get $16)
     (local.get $18)
    )
   )
   (local.set $10
    (local.get $22)
   )
   (local.set $12
    (local.get $21)
   )
   (local.set $14
    (local.get $4)
   )
   (local.set $18
    (local.get $20)
   )
   (br_if $label2
    (i32.ne
     (local.tee $5
      (i32.add
       (local.get $5)
       (i32.const 4)
      )
     )
     (i32.const 256)
    )
   )
  )
  (i32.store offset=108
   (local.get $0)
   (i32.add
    (local.get $22)
    (local.get $9)
   )
  )
  (i32.store offset=104
   (local.get $0)
   (i32.add
    (local.get $21)
    (local.get $11)
   )
  )
  (i32.store offset=100
   (local.get $0)
   (i32.add
    (local.get $4)
    (local.get $13)
   )
  )
  (i32.store offset=96
   (local.get $0)
   (i32.add
    (local.get $16)
    (local.get $15)
   )
  )
  (i32.store offset=92
   (local.get $0)
   (i32.add
    (local.get $20)
    (local.get $17)
   )
  )
  (i32.store offset=88
   (local.get $0)
   (i32.add
    (local.get $1)
    (local.get $19)
   )
  )
  (i32.store offset=84
   (local.get $0)
   (i32.add
    (local.get $3)
    (local.get $8)
   )
  )
  (i32.store offset=80
   (local.get $0)
   (i32.add
    (local.get $7)
    (local.get $6)
   )
  )
  (global.set $__stack_pointer
   (i32.add
    (local.get $2)
    (i32.const 256)
   )
  )
 )
 (func $sha256_init (type $4) (param $0 i32)
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
 (func $sha256_update (type $5) (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (block $block
   (br_if $block
    (i32.eqz
     (local.get $2)
    )
   )
   (local.set $3
    (i32.load offset=64
     (local.get $0)
    )
   )
   (loop $label
    (i32.store8
     (i32.add
      (local.get $0)
      (local.get $3)
     )
     (i32.load8_u
      (local.get $1)
     )
    )
    (i32.store offset=64
     (local.get $0)
     (local.tee $3
      (i32.add
       (i32.load offset=64
        (local.get $0)
       )
       (i32.const 1)
      )
     )
    )
    (block $block1
     (br_if $block1
      (i32.ne
       (local.get $3)
       (i32.const 64)
      )
     )
     (call $sha256_transform
      (local.get $0)
      (local.get $0)
     )
     (local.set $3
      (i32.const 0)
     )
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
    (local.set $1
     (i32.add
      (local.get $1)
      (i32.const 1)
     )
    )
    (br_if $label
     (local.tee $2
      (i32.add
       (local.get $2)
       (i32.const -1)
      )
     )
    )
   )
  )
 )
 (func $sha256_final (type $2) (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i64)
  (i32.store8
   (local.tee $3
    (i32.add
     (local.get $0)
     (local.tee $2
      (i32.load offset=64
       (local.get $0)
      )
     )
    )
   )
   (i32.const 128)
  )
  (block $block1
   (block $block
    (br_if $block
     (i32.gt_u
      (local.get $2)
      (i32.const 55)
     )
    )
    (br_if $block1
     (i32.eq
      (local.get $2)
      (i32.const 55)
     )
    )
    (local.set $4
     (local.get $2)
    )
    (block $block2
     (br_if $block2
      (i32.eq
       (local.tee $5
        (i32.and
         (local.get $2)
         (i32.const 7)
        )
       )
       (i32.const 7)
      )
     )
     (local.set $4
      (i32.add
       (local.get $3)
       (i32.const 1)
      )
     )
     (local.set $6
      (i32.const 0)
     )
     (loop $label
      (i32.store8
       (i32.add
        (local.get $4)
        (local.get $6)
       )
       (i32.const 0)
      )
      (br_if $label
       (i32.ne
        (i32.xor
         (local.get $5)
         (local.tee $6
          (i32.add
           (local.get $6)
           (i32.const 1)
          )
         )
        )
        (i32.const 7)
       )
      )
     )
     (local.set $4
      (i32.add
       (local.get $2)
       (local.get $6)
      )
     )
    )
    (br_if $block1
     (i32.lt_u
      (i32.add
       (local.get $2)
       (i32.const -48)
      )
      (i32.const 7)
     )
    )
    (local.set $3
     (i32.const 55)
    )
    (local.set $6
     (local.get $0)
    )
    (loop $label1
     (i64.store align=1
      (i32.add
       (i32.add
        (local.get $6)
        (local.get $4)
       )
       (i32.const 1)
      )
      (i64.const 0)
     )
     (local.set $6
      (i32.add
       (local.get $6)
       (i32.const 8)
      )
     )
     (br_if $label1
      (i32.ne
       (local.get $4)
       (local.tee $3
        (i32.add
         (local.get $3)
         (i32.const -8)
        )
       )
      )
     )
     (br $block1)
    )
   )
   (block $block3
    (br_if $block3
     (i32.gt_u
      (local.tee $4
       (i32.add
        (local.get $2)
        (i32.const 1)
       )
      )
      (i32.const 63)
     )
    )
    (block $block4
     (br_if $block4
      (i32.eq
       (local.tee $5
        (i32.and
         (local.get $2)
         (i32.const 7)
        )
       )
       (i32.const 7)
      )
     )
     (local.set $6
      (i32.const 1)
     )
     (loop $label2
      (i32.store8
       (i32.add
        (local.get $3)
        (local.get $6)
       )
       (i32.const 0)
      )
      (local.set $4
       (i32.xor
        (local.get $5)
        (local.get $6)
       )
      )
      (local.set $6
       (local.tee $7
        (i32.add
         (local.get $6)
         (i32.const 1)
        )
       )
      )
      (br_if $label2
       (i32.ne
        (local.get $4)
        (i32.const 7)
       )
      )
     )
     (local.set $4
      (i32.add
       (local.get $2)
       (local.get $7)
      )
     )
    )
    (br_if $block3
     (i32.lt_u
      (i32.add
       (local.get $2)
       (i32.const -56)
      )
      (i32.const 7)
     )
    )
    (local.set $3
     (i32.const 64)
    )
    (local.set $6
     (local.get $0)
    )
    (loop $label3
     (i64.store align=1
      (i32.add
       (local.get $6)
       (local.get $4)
      )
      (i64.const 0)
     )
     (local.set $6
      (i32.add
       (local.get $6)
       (i32.const 8)
      )
     )
     (br_if $label3
      (i32.ne
       (local.get $4)
       (local.tee $3
        (i32.add
         (local.get $3)
         (i32.const -8)
        )
       )
      )
     )
    )
   )
   (call $sha256_transform
    (local.get $0)
    (local.get $0)
   )
   (drop
    (call $memset
     (local.get $0)
     (i32.const 0)
     (i32.const 56)
    )
   )
  )
  (i64.store offset=72
   (local.get $0)
   (local.tee $8
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
   (local.get $8)
  )
  (i64.store8 offset=62
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 8)
   )
  )
  (i64.store8 offset=61
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 16)
   )
  )
  (i64.store8 offset=60
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 24)
   )
  )
  (i64.store8 offset=59
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 32)
   )
  )
  (i64.store8 offset=58
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 40)
   )
  )
  (i64.store8 offset=57
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 48)
   )
  )
  (i64.store8 offset=56
   (local.get $0)
   (i64.shr_u
    (local.get $8)
    (i64.const 56)
   )
  )
  (call $sha256_transform
   (local.get $0)
   (local.get $0)
  )
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
 ;; custom section "producers", size 37
 ;; features section: threads, mutable-globals, nontrapping-float-to-int, simd, bulk-memory, sign-ext, exception-handling, tail-call, reference-types, multivalue, gc, memory64, relaxed-simd, extended-const, strings, multimemory, stack-switching, shared-everything, fp16, bulk-memory-opt, call-indirect-overlong, custom-descriptors, acquire-release-atomics, custom-page-sizes, multibyte, wide-arithmetic, compact-imports, relaxed-atomics
)
