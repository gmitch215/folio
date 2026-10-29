import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import { prepareContext } from '../../src/compiler.ts';
import { ContextResetError, InstanceCheckpoint } from '../../src/context.ts';

const compile = (wat: string) => {
	const module = binaryen.parseText(wat);
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		module.setFeatures(binaryen.Features.All & ~compact);
		expect(module.validate()).toBeTruthy();
		return Uint8Array.from(module.emitBinary());
	} finally {
		module.dispose();
	}
};

test('private checkpoints restore hidden memory, globals and function table references across different inputs', () => {
	const bytes = compile(`(module
		(memory 3 4) (global $state (mut i32) (i32.const 17))
		(table 2 4 funcref) (elem (i32.const 0) $one $two)
		(func $one (result i32) (i32.const 1)) (func $two (result i32) (i32.const 2))
		(func (export "write") (param i32 i32) (i32.store (local.get 0) (local.get 1)) (global.set $state (local.get 1)) (table.set (i32.const 0) (ref.func $two)))
		(func (export "read") (result i32) (global.get $state)))`);
	const plan = prepareContext(bytes);
	expect(plan.reasons).toEqual([]);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(plan.bytes)));
	const checkpoint = new InstanceCheckpoint(instance, plan),
		memory = instance.exports[plan.memories[0]!] as WebAssembly.Memory;
	const table = instance.exports[plan.tables[0]!] as WebAssembly.Table,
		first = table.get(0);
	for (const [address, value] of [
		[4, 100],
		[65539, -7],
		[131076, 39]
	]) {
		(instance.exports.write as CallableFunction)(address, value);
		const report = checkpoint.restore();
		expect(report).toMatchObject({
			checkedBytes: 3 * 65536,
			copiedBytes: 65536,
			changedPages: 1,
			globals: 1,
			tableSlots: 1
		});
		expect(new Uint8Array(memory.buffer).every((byte) => byte === 0)).toBe(true);
		expect((instance.exports.read as CallableFunction)()).toBe(17);
		expect(table.get(0)).toBe(first);
	}
	expect(checkpoint.restore().copiedBytes).toBe(0);
	expect(checkpoint.restore('full')).toMatchObject({ checkedBytes: 0, copiedBytes: 3 * 65536 });
});

test('growth refuses before changing any binding so a caller can recreate the context', () => {
	const plan = prepareContext(
		compile('(module (memory (export "m") 1 2) (table (export "t") 1 2 funcref))')
	);
	const open = () =>
		new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(plan.bytes)));
	const instance = open(),
		checkpoint = new InstanceCheckpoint(instance, plan),
		memory = instance.exports.m as WebAssembly.Memory;
	memory.grow(1);
	new Uint8Array(memory.buffer)[0] = 99;
	expect(() => checkpoint.restore()).toThrow(ContextResetError);
	expect(new Uint8Array(memory.buffer)[0]).toBe(99);
	const second = open(),
		snapshot = new InstanceCheckpoint(second, plan);
	(second.exports.t as WebAssembly.Table).grow(1);
	expect(() => snapshot.restore()).toThrow(/table-size/);
	expect(() => new InstanceCheckpoint(open(), plan).restore()).not.toThrow();
});

test('checkpoint preparation preserves start execution and refuses runtime passive-segment mutation', () => {
	const initial = prepareContext(
		compile(`(module (memory (export "m") 1)
		(data $d "x") (func $start (memory.init $d (i32.const 0) (i32.const 0) (i32.const 1)) (data.drop $d))
		(start $start) (func (export "f") (result i32) (i32.load8_u (i32.const 0))))`)
	);
	expect(initial.reasons.join()).toMatch(/segment drop/);
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(initial.bytes))
	);
	expect((instance.exports.f as CallableFunction)()).toBe(120);
	const mutating = prepareContext(
		compile('(module (memory 1) (data $d "x") (func (export "drop") (data.drop $d)))')
	);
	expect(mutating.reasons.join()).toMatch(/segment drop/);
	expect(mutating.bytes).toEqual(mutating.original);
	expect(() => new InstanceCheckpoint(instance, mutating)).toThrow(/recreation/);
});

test('a segment drop inside a catch body or an offset expression refuses reuse', () => {
	const caught = prepareContext(
		compile(`(module (memory 1) (data $d "x") (tag $t)
		(func (export "f") (try (do (nop)) (catch $t (data.drop $d)))))`)
	);
	expect(caught.reasons.join()).toMatch(/segment drop/);
	expect(caught.bytes).toEqual(caught.original);
	const element = prepareContext(
		compile(`(module (table 1 funcref) (elem $e func)
		(func (export "f") (elem.drop $e)))`)
	);
	expect(element.reasons.join()).toMatch(/segment drop/);
});

test('imported mutable globals and memory are restored and alias exports avoid original names', () => {
	const plan = prepareContext(
		compile(`(module (import "env" "g" (global $g (mut i64)))
		(import "env" "m" (memory 1)) (func (export "__folio_context_original")))`)
	);
	expect(plan.reasons).toEqual([]);
	expect(plan.memories[0]).not.toBe('__folio_context_original');
	const global = new WebAssembly.Global({ value: 'i64', mutable: true }, 8n),
		memory = new WebAssembly.Memory({ initial: 1 });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(plan.bytes)), {
		env: { g: global, m: memory }
	});
	const checkpoint = new InstanceCheckpoint(instance, plan);
	global.value = -9n;
	new Uint8Array(memory.buffer)[60000] = 7;
	checkpoint.restore();
	expect(global.value).toBe(8n);
	expect(new Uint8Array(memory.buffer)[60000]).toBe(0);
});

test('unrepresentable state retains the original module and invalid bindings are refused', () => {
	const vector = prepareContext(
		compile('(module (global (mut v128) (v128.const i32x4 0 0 0 0)))')
	);
	expect(vector.reasons.join()).toMatch(/v128/);
	expect(vector.bytes).toEqual(vector.original);
	const plan = prepareContext(compile('(module (memory 1))'));
	expect(
		() =>
			new InstanceCheckpoint(
				new WebAssembly.Instance(new WebAssembly.Module(compile('(module)'))),
				plan
			)
	).toThrow(/memory/);
	const empty = prepareContext(compile('(module)')),
		instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(empty.bytes)));
	expect(new InstanceCheckpoint(instance, empty).restore()).toMatchObject({ copiedBytes: 0 });
});

test('a plan naming exports the instance lacks, or an unknown restore strategy, is refused', () => {
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(compile('(module (memory (export "m") 1))'))
	);
	const plan = (extra: Partial<ReturnType<typeof prepareContext>>) => ({
		original: new Uint8Array(),
		bytes: new Uint8Array(),
		memories: [] as string[],
		globals: [] as string[],
		tables: [] as string[],
		reasons: [] as string[],
		...extra
	});
	expect(() => new InstanceCheckpoint(instance, plan({ memories: ['absent'] }))).toThrow(
		/missing context memory/
	);
	expect(() => new InstanceCheckpoint(instance, plan({ globals: ['absent'] }))).toThrow(
		/missing context global/
	);
	expect(() => new InstanceCheckpoint(instance, plan({ tables: ['absent'] }))).toThrow(
		/missing context table/
	);
	expect(
		() =>
			new InstanceCheckpoint(instance, plan({ reasons: ['v128 globals require recreation'] }))
	).toThrow(/recreation/);
	const checkpoint = new InstanceCheckpoint(instance, plan({ memories: ['m'] }));
	expect(() => checkpoint.restore('bad' as 'full')).toThrow(/invalid context reset strategy/);
	expect(checkpoint.restore('full').copiedBytes).toBe(65536);
});
