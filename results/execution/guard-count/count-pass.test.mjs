// fixture test for count-pass.mjs. per loop iteration the fixture makes 6 accesses and 5 checks:
//   load via p after local.set p (check), load via p+8 (same version, no check),
//   load via i (check), load via n+i (other pointer, check), load via q after local.tee q (check),
//   memory.fill (access + check); plus one call. p, i and q are re-set each iteration.
// expected for n iterations: access 6n, check 5n, call n.
import assert from 'node:assert/strict';
import binaryen from 'binaryen';
import { instrument } from './count-pass.mjs';

const WAT = `(module
  (memory (export "memory") 1)
  (func $g)
  (func (export "f") (param $n i32) (result i32) (local $p i32) (local $i i32) (local $q i32)
    (block $done
      (loop $L
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $p (i32.const 16))
        (drop (i32.load (local.get $p)))
        (drop (i32.load offset=4 (i32.add (local.get $p) (i32.const 8))))
        (drop (i32.load (local.get $i)))
        (drop (i32.load (i32.add (local.get $n) (local.get $i))))
        (drop (local.tee $q (i32.const 32)))
        (drop (i32.load (local.get $q)))
        (memory.fill (i32.const 0) (i32.const 0) (i32.const 4))
        (call $g)
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $L)))
    (i32.const 7)))`;

const parsed = binaryen.parseText(WAT);
parsed.setFeatures(binaryen.Features.All);
assert.equal(parsed.validate(), 1);
const mod = binaryen.readBinary(parsed.emitBinary());
assert.equal(mod.validate(), 0, 'the plain fixture needs bulk memory, so it is not a valid input here');
const stats = instrument(mod);
assert.equal(mod.validate(), 1, 'instrumented fixture must validate');
const bytes = mod.emitBinary();

const cases = [
	[0, { access: 0n, check: 0n, call: 0n }],
	[1, { access: 6n, check: 5n, call: 1n }],
	[5, { access: 30n, check: 25n, call: 5n }]
];
for (const [n, want] of cases) {
	const { instance } = await WebAssembly.instantiate(bytes, {});
	assert.equal(instance.exports.f(n), 7, `f(${n}) must still return 7`);
	const got = {
		access: instance.exports.q_access.value,
		check: instance.exports.q_check.value,
		call: instance.exports.q_call.value
	};
	assert.deepEqual(got, want, `counts for n=${n}`);
}

console.log(JSON.stringify({ test: 'count-pass fixture', ok: true, stats }));
