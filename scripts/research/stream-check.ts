import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AffineModel } from '../../src/affine.ts';

// binaryen throws a raw TypeError for kinds it cannot describe, such as nop
const info = (expr: number) => {
	try {
		return binaryen.getExpressionInfo(expr) as any;
	} catch {
		throw new assert.AssertionError({
			message: `expression kind ${binaryen.getExpressionId(expr)} has no readable form`
		});
	}
};
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
const template = `(module (memory 2)
	(func $step (param i32 i32) (result i32) (i32.const 0))
	(func $update (param i32 i32 i32) (result i32)
		(block $done (br_if $done (i32.eqz (local.get 2)))
			(loop $again
				(local.set 0 (call $step (local.get 0) (i32.load8_u (local.get 1))))
				(local.set 1 (i32.add (local.get 1) (i32.const 1)))
				(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
		(local.get 0)))`;

function skeleton(expr: number, step: string, labels = new Map<string, number>()): unknown {
	const v = info(expr);
	const child = (e: number) => skeleton(e, step, labels);
	const label = (name: string) => {
		if (!labels.has(name)) labels.set(name, labels.size);
		return labels.get(name);
	};
	switch (v.id) {
		case binaryen.BlockId:
			return ['block', v.type, v.name ? label(v.name) : null, ...v.children.map(child)];
		case binaryen.LoopId:
			return ['loop', v.type, label(v.name), child(v.body)];
		case binaryen.BreakId:
			assert.ok(labels.has(v.name));
			return [
				'br',
				v.type,
				labels.get(v.name),
				v.condition ? child(v.condition) : null,
				v.value ? child(v.value) : null
			];
		case binaryen.LocalGetId:
			return ['get', v.type, v.index];
		case binaryen.LocalSetId:
			return ['set', v.type, v.index, v.isTee, child(v.value)];
		case binaryen.CallId:
			assert.equal(v.target, step);
			assert.equal(v.isReturn, false);
			return ['call-step', v.type, ...v.operands.map(child)];
		case binaryen.LoadId:
			assert.equal(v.isAtomic, false);
			return ['load', v.type, v.bytes, v.isSigned, v.offset, child(v.ptr)];
		case binaryen.UnaryId:
			return ['unary', v.type, v.op, child(v.value)];
		case binaryen.BinaryId:
			return ['binary', v.type, v.op, child(v.left), child(v.right)];
		case binaryen.ConstId:
			assert.equal(v.type, binaryen.i32);
			return ['const', v.value];
		default:
			throw new Error(`unsupported wrapper expression ${v.id}`);
	}
}

export function toSharedImport(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const module = binaryen.readBinary(bytes);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	assert.equal((text.match(/\(memory \$0 2 8192\)/g) ?? []).length, 1);
	const shared = binaryen.parseText(
		text.replace('(memory $0 2 8192)', '(import "env" "memory" (memory $0 2 8192 shared))')
	);
	shared.setFeatures(binaryen.Features.All & ~compact);
	const out = Uint8Array.from(shared.emitBinary());
	shared.dispose();
	return out;
}

export function checkStream(
	bytes: Uint8Array,
	entry = 'update',
	stepExport = 'transition',
	{ sharedImport = false }: { sharedImport?: boolean } = {}
) {
	const native = new WebAssembly.Module(Uint8Array.from(bytes));
	const imports = WebAssembly.Module.imports(native);
	if (sharedImport) {
		assert.deepEqual(
			imports,
			[{ module: 'env', name: 'memory', kind: 'memory' }],
			'one imported memory required'
		);
	} else assert.equal(imports.length, 0, 'imports refuse');
	let cursor = 8;
	const leb = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	let memoryCount = 0;
	while (cursor < bytes.length) {
		const id = bytes[cursor++]!,
			length = leb(),
			end = cursor + length;
		if (id === 5) memoryCount = leb();
		cursor = end;
	}
	assert.equal(memoryCount, sharedImport ? 0 : 1, 'memory declaration shape');
	const module = binaryen.readBinary(bytes),
		reference = binaryen.parseText(template);
	try {
		module.setFeatures(binaryen.Features.All & ~compact);
		assert.equal(module.getStart(), 0, 'start refuses');
		assert.equal(
			(module as any).getNumDataSegments(),
			0,
			'initializing data segments refuse shared backend promotion'
		);
		assert.equal(module.getMemoryInfo().shared, sharedImport, 'memory sharing');
		assert.equal(module.getMemoryInfo().is64, false, 'wasm32 required');
		const resolve = (name: string) => {
			const item = binaryen.getExportInfo(module.getExport(name));
			assert.equal(item.kind, binaryen.ExternalFunction);
			return item.value;
		};
		const target = resolve(stepExport),
			wrapper = binaryen.getFunctionInfo(module.getFunction(resolve(entry)));
		assert.equal(
			wrapper.params,
			binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32])
		);
		assert.equal(wrapper.results, binaryen.i32);
		assert.equal(wrapper.vars.length, 0);
		assert.deepEqual(
			skeleton(wrapper.body, target),
			skeleton(binaryen.getFunctionInfo(reference.getFunction('update')).body, 'step')
		);
		const step = binaryen.getFunctionInfo(module.getFunction(target));
		assert.equal(step.params, binaryen.createType([binaryen.i32, binaryen.i32]));
		assert.equal(step.results, binaryen.i32);
		assert.ok(step.vars.every((type) => type === binaryen.i32));
		type Bits = bigint[];
		const C = 1n << 64n;
		const constant = (value: number): Bits =>
			Array.from({ length: 32 }, (_, k) => ((value >>> k) & 1 ? C : 0n));
		const locals: Bits[] = [
			Array.from({ length: 32 }, (_, k) => 1n << BigInt(k)),
			Array.from({ length: 32 }, (_, k) => 1n << BigInt(k + 32)),
			...step.vars.map(() => constant(0))
		];
		let expressions = 0;
		function evaluate(expr: number): Bits {
			expressions++;
			const v = info(expr);
			if (v.id === binaryen.LocalGetId) {
				assert.ok(locals[v.index]);
				return locals[v.index]!;
			}
			if (v.id === binaryen.LocalSetId) {
				assert.ok(locals[v.index]);
				return (locals[v.index] = evaluate(v.value));
			}
			if (v.id === binaryen.BlockId) {
				assert.equal(v.name, null);
				let result = constant(0);
				for (const child of v.children) result = evaluate(child);
				return result;
			}
			if (v.id === binaryen.ConstId) {
				assert.equal(v.type, binaryen.i32);
				return constant(v.value);
			}
			assert.equal(v.id, binaryen.BinaryId, 'step must be pure supported arithmetic');
			assert.equal(v.type, binaryen.i32);
			const a = evaluate(v.left),
				b = evaluate(v.right),
				left = info(v.left),
				right = info(v.right);
			if (v.op === binaryen.XorInt32) return a.map((bit, k) => bit ^ b[k]!);
			if (right.id === binaryen.ConstId) {
				const shift = right.value & 31;
				if (v.op === binaryen.ShrUInt32) return a.map((_, k) => a[k + shift] ?? 0n);
				if (v.op === binaryen.ShrSInt32) return a.map((_, k) => a[k + shift] ?? a[31]!);
				if (v.op === binaryen.ShlInt32)
					return a.map((_, k) => (k < shift ? 0n : a[k - shift]!));
			}
			if (v.op === binaryen.AndInt32) {
				if (left.id === binaryen.ConstId)
					return b.map((bit, k) => ((left.value >>> k) & 1 ? bit : 0n));
				if (right.id === binaryen.ConstId)
					return a.map((bit, k) => ((right.value >>> k) & 1 ? bit : 0n));
			}
			if (
				v.op === binaryen.SubInt32 &&
				a.every((bit) => bit === 0n) &&
				b.slice(1).every((bit) => bit === 0n)
			)
				return Array(32).fill(b[0]);
			throw new Error(`unsupported step operation ${v.op}`);
		}
		const bits = evaluate(step.body);
		const operator = Array.from({ length: 32 }, (_, k) =>
			bits.reduce(
				(out, coefficients, output) =>
					out | (((coefficients >> BigInt(k)) & 1n) << BigInt(output)),
				0n
			)
		);
		const model: AffineModel = {
			kind: 'model',
			ring: 'gf2',
			bits: 32,
			align: 1,
			layout: { entry, state: 0, ptr: 1, len: 2, bits: 32 },
			operator,
			calls: 0,
			checks: []
		};
		Object.freeze(operator);
		Object.freeze(model.layout);
		Object.freeze(model.checks);
		Object.freeze(model);
		return {
			model,
			guardInput: (memoryBytes: number, pointer: number, length: number) =>
				Number.isSafeInteger(memoryBytes) &&
				memoryBytes >= 0 &&
				memoryBytes <= 4294967296 &&
				(pointer >>> 0) + (length >>> 0) <= memoryBytes,
			evidence: {
				moduleSha256: createHash('sha256').update(bytes).digest('hex'),
				expressions,
				stepExport,
				entry,
				schema: 'experimental-linear-byte-stream-v1',
				guard: 'exclusive immutable input; (ptr >>> 0) + (len >>> 0) <= memory byte length',
				observation:
					'return i32 only; complete entry closure has no stores, globals or host calls'
			}
		};
	} finally {
		module.dispose();
		reference.dispose();
	}
}
