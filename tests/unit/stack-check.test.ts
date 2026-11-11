import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import { stackCheck, StackCheckRefusal } from '../../scripts/research/stack-check.ts';

const LIMIT = 65536;
const START = 131072;

function assemble(body: string, extra = '') {
	const wat = `(module (memory (export "mem") 2) (global $sp (mut i32) (i32.const ${START})) ${extra} ${body})`;
	const mod = binaryen.parseText(wat);
	mod.setFeatures(binaryen.Features.MVP);
	const bytes = mod.emitBinary();
	mod.dispose();
	return bytes;
}

function run(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes);
	expect(WebAssembly.validate(copy)).toBe(true);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(copy), {});
	return instance.exports as any;
}

const below = (e: any) => new Uint8Array(e.mem.buffer, 0, LIMIT);
const changed = (e: any) => below(e).some((b) => b !== 0);

const rec = `(func $rec (export "rec") (param $n i32) (result i32) (local $t i32)
	(if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
	(global.set $sp (local.tee $t (i32.sub (global.get $sp) (i32.const 64))))
	(i32.store (local.get $t) (local.get $n))
	(drop (call $rec (i32.sub (local.get $n) (i32.const 1))))
	(global.set $sp (i32.add (local.get $t) (i32.const 64)))
	(i32.load (local.get $t)))`;

test('a fixed frame recursion traps at the limit with the data below it untouched', () => {
	const input = assemble(rec);
	const plain = run(input);
	expect(plain.rec(1100)).toBe(1100);
	expect(changed(plain)).toBe(true);

	const { bytes, stats } = stackCheck(input, { limit: LIMIT });
	expect(stats.checks).toBe(1);
	expect(stats.locals).toBe(0);
	expect(stats.sites.lowerConst).toBe(1);
	expect(stats.sites.raise).toBe(1);
	const guarded = run(bytes);
	expect(guarded.rec(1000)).toBe(1000);
	expect(() => guarded.rec(1100)).toThrow(/unreachable/);
	expect(changed(guarded)).toBe(false);
});

test('the fresh local option adds a local per check and traps the same way', () => {
	const input = assemble(rec);
	const { bytes, stats } = stackCheck(input, { limit: LIMIT, freshLocal: true });
	expect(stats.locals).toBe(1);
	const guarded = run(bytes);
	expect(guarded.rec(1000)).toBe(1000);
	expect(() => guarded.rec(1100)).toThrow(/unreachable/);
	expect(changed(guarded)).toBe(false);
});

test('a frame that ends exactly at the limit is allowed and one byte lower traps', () => {
	const ok = assemble(
		`(func (export "at") (result i32) (local $t i32) (global.set $sp (local.tee $t (i32.sub (global.get $sp) (i32.const ${START - LIMIT})))) (global.get $sp))
		(func (export "under") (result i32) (local $t i32) (global.set $sp (local.tee $t (i32.sub (global.get $sp) (i32.const ${START - LIMIT + 1})))) (global.get $sp))`
	);
	const { bytes } = stackCheck(ok, { limit: LIMIT });
	expect(run(bytes).at()).toBe(LIMIT);
	expect(() => run(bytes).under()).toThrow(/unreachable/);
});

test('a constant frame larger than the limit is also tested for wrap around', () => {
	const input = assemble(
		`(func (export "set") (param $v i32) (global.set $sp (local.get $v)))
		(func (export "big") (result i32) (local $t i32) (global.set $sp (local.tee $t (i32.sub (global.get $sp) (i32.const 70000)))) (local.get $t))`
	);
	const e = run(input);
	e.set(LIMIT + 100);
	expect(e.big()).toBe((LIMIT + 100 - 70000) | 0);
	const guarded = run(stackCheck(input, { limit: LIMIT }).bytes);
	guarded.set(LIMIT + 100);
	expect(() => guarded.big()).toThrow(/unreachable/);
});

test('a function that does not write the stack pointer gets no check', () => {
	const input = assemble(
		`(func (export "f") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))`
	);
	const { bytes, stats } = stackCheck(input, { limit: LIMIT });
	expect(stats.checks).toBe(0);
	expect(stats.writers).toBe(0);
	expect(run(bytes).f(4)).toBe(5);
});

test('an alloca style decrement is checked for the limit and for wrap around', () => {
	const input = assemble(
		`(func (export "alloca") (param $n i32) (result i32) (local $t i32)
			(global.set $sp (local.tee $t (i32.and (i32.sub (global.get $sp) (local.get $n)) (i32.const -16))))
			(local.get $t))`
	);
	const plain = run(input);
	expect(plain.alloca(70000)).toBeLessThan(LIMIT);
	const rewritten = stackCheck(input, { limit: LIMIT });
	expect(rewritten.stats.sites.lowerVar).toBe(1);
	expect(rewritten.stats.locals).toBe(1);
	const guarded = run(rewritten.bytes);
	expect(guarded.alloca(100)).toBe((START - 100) & -16);
	expect(() => guarded.alloca(70000)).toThrow(/unreachable/);
	const wrapped = run(input);
	expect(wrapped.alloca(-4096)).toBe(START + 4096);
	const g2 = run(rewritten.bytes);
	expect(() => g2.alloca(-4096)).toThrow(/unreachable/);
});

test('a function that lowers twice has both sites checked and only the second can trap', () => {
	const input = assemble(
		`(func (export "two") (param $n i32) (result i32) (local $a i32) (local $b i32)
			(global.set $sp (local.tee $a (i32.sub (global.get $sp) (i32.const 64))))
			(global.set $sp (local.tee $b (i32.sub (local.get $a) (local.get $n))))
			(local.get $b))`
	);
	expect(() => stackCheck(input, { limit: LIMIT })).not.toThrow();
	const { bytes, stats } = stackCheck(input, { limit: LIMIT });
	expect(stats.checks).toBe(2);
	expect(stats.multi).toBe(1);
	const e = run(bytes);
	expect(e.two(16)).toBe(START - 64 - 16);
	const e2 = run(bytes);
	expect(() => e2.two(START)).toThrow(/unreachable/);
});

test('a pointer kept in a local across a call is checked at the later lowering', () => {
	const input = assemble(
		`(func $nop (param i32))
		(func (export "keep") (param $n i32) (result i32) (local $x i32) (local $t i32)
			(local.set $x (global.get $sp))
			(call $nop (local.get $n))
			(global.set $sp (local.tee $t (i32.add (local.get $x) (i32.const -${START - LIMIT + 32}))))
			(local.get $t))`
	);
	const { bytes, stats } = stackCheck(input, { limit: LIMIT });
	expect(stats.sites.lowerConst).toBe(1);
	expect(() => run(bytes).keep(1)).toThrow(/unreachable/);
	expect(run(input).keep(1)).toBe(LIMIT - 32);
});

test('a restore from a local is checked and a raise by a constant is not', () => {
	const input = assemble(
		`(func (export "restore") (param $v i32) (global.set $sp (local.get $v)))
		(func (export "raise") (global.set $sp (i32.add (global.get $sp) (i32.const 16))))
		(func (export "get") (result i32) (global.get $sp))`
	);
	const { bytes, stats } = stackCheck(input, { limit: LIMIT });
	expect(stats.sites.local).toBe(1);
	expect(stats.sites.raise).toBe(1);
	expect(stats.checks).toBe(1);
	expect(stats.locals).toBe(1);
	const e = run(bytes);
	e.restore(LIMIT);
	expect(e.get()).toBe(LIMIT);
	expect(() => e.restore(LIMIT - 1)).toThrow(/unreachable/);
});

test('the control round trip inserts nothing and keeps the behaviour', () => {
	const input = assemble(rec);
	const { bytes, stats } = stackCheck(input, { limit: LIMIT, insert: false });
	expect(stats.checks).toBe(0);
	const e = run(bytes);
	expect(e.rec(1100)).toBe(1100);
	expect(changed(e)).toBe(true);
});

test('the limit comes from the module stack end when no option is given', () => {
	const input = assemble(
		rec,
		`(global $end (mut i32) (i32.const 0))
		(func (export "emscripten_stack_get_end") (result i32) (global.get $end))
		(func (export "emscripten_stack_init") (global.set $end (i32.const ${LIMIT})))`
	);
	const { bytes, stats } = stackCheck(input);
	expect(stats.limit).toBe(LIMIT);
	expect(() => run(bytes).rec(1100)).toThrow(/unreachable/);
	expect(() => stackCheck(input, { limit: LIMIT + 16 })).toThrow(
		/limit 65552 differs from the module stack end 65536/
	);
});

test('a module with no stack end and no option is refused', () => {
	expect(() => stackCheck(assemble(rec))).toThrow(/no stack end/);
});

test('a refusal names the function and fails the whole module', () => {
	const constSet = assemble(
		`(func (export "ok") (local $t i32) (global.set $sp (local.tee $t (i32.sub (global.get $sp) (i32.const 16)))))
		(func $odd (export "odd") (global.set $sp (i32.const 70000)))`
	);
	let error: StackCheckRefusal | undefined;
	try {
		stackCheck(constSet, { limit: LIMIT });
	} catch (e) {
		error = e as StackCheckRefusal;
	}
	expect(error).toBeInstanceOf(StackCheckRefusal);
	expect(error!.reasons).toHaveLength(1);
	expect(error!.reasons[0]).toMatch(/function 1 \(odd\).*constant/);

	const twoVars = assemble(
		`(func (export "bad") (param i32 i32) (global.set $sp (i32.add (local.get 0) (local.get 1))))`
	);
	expect(() => stackCheck(twoVars, { limit: LIMIT })).toThrow(
		/function 0 \(bad\).*add of two non-constants/
	);

	const viaCall = assemble(
		`(func $f (result i32) (i32.const 1))
		(func (export "bad") (global.set $sp (call $f)))`
	);
	expect(() => stackCheck(viaCall, { limit: LIMIT })).toThrow(/function 1 \(bad\).*call/);

	const multi = assemble(
		`(func (export "x") (param i32) (global.set $sp (i32.mul (local.get 0) (i32.const 2))))`
	);
	expect(() => stackCheck(multi, { limit: LIMIT })).toThrow(/function 0 \(x\)/);
});

test('a module without globals is refused', () => {
	const mod = binaryen.parseText('(module (memory 1) (func (export "f")))');
	const bytes = mod.emitBinary();
	mod.dispose();
	expect(() => stackCheck(bytes, { limit: LIMIT })).toThrow(/no stack pointer global/);
});
