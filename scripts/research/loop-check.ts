import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AffineModel } from '../../src/affine.ts';

// spike: certify a real clang loop (step inlined, conditioning pair) as a GF(2) byte stream
export class Refusal extends Error {}
const refuse = (why: string): never => {
	throw new Refusal(why);
};

// binaryen throws a raw TypeError for kinds it cannot describe, such as nop
const info = (expr: number) => {
	try {
		return binaryen.getExpressionInfo(expr) as any;
	} catch {
		return refuse(`expression kind ${binaryen.getExpressionId(expr)} has no readable form`);
	}
};
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

export function checkLoop(bytes: Uint8Array, entry = 'update') {
	const native = new WebAssembly.Module(Uint8Array.from(bytes));
	if (WebAssembly.Module.imports(native).length) refuse('imports');
	const module = binaryen.readBinary(bytes);
	try {
		module.setFeatures(binaryen.Features.All & ~compact);
		if (module.getStart() !== 0) refuse('start function');
		if ((module as any).getNumDataSegments() !== 0) refuse('data segments');
		const exported = binaryen.getExportInfo(module.getExport(entry));
		const fn = binaryen.getFunctionInfo(module.getFunction(exported.value));
		const params = binaryen.expandType(fn.params);
		if (params.length !== 3 || params.some((t) => t !== binaryen.i32)) refuse('entry shape');
		if (fn.results !== binaryen.i32) refuse('result type');
		const W = 32;
		const CONST = 1n << BigInt(W + 8);
		type Bits = bigint[];
		const constant = (value: number): Bits =>
			Array.from({ length: W }, (_, k) => ((value >>> k) & 1 ? CONST : 0n));
		const unit = (offset: number): Bits =>
			Array.from({ length: W }, (_, k) => 1n << BigInt(offset + k));
		const byteBits = (): Bits =>
			Array.from({ length: W }, (_, k) => (k < 8 ? 1n << BigInt(W + k) : 0n));
		const PTR = 1;
		const LEN = 2;
		const nlocals = params.length + fn.vars.length;
		if (fn.vars.some((t) => t !== binaryen.i32)) refuse('non-i32 local');

		class Ctx {
			locals: (Bits | undefined)[] = Array(nlocals).fill(undefined);
			allowByte: boolean;
			constructor(allowByte: boolean) {
				this.allowByte = allowByte;
			}
			symbolic(expr: number): Bits {
				const v = info(expr);
				switch (v.id) {
					case binaryen.LocalGetId: {
						if (v.index === PTR || v.index === LEN)
							refuse('pointer or length used as data');
						const bits = this.locals[v.index];
						if (!bits) refuse(`local ${v.index} read before it is defined`);
						return bits!;
					}
					case binaryen.LocalSetId: {
						if (v.index === PTR || v.index === LEN)
							refuse('pointer or length written as data');
						return (this.locals[v.index] = this.symbolic(v.value));
					}
					case binaryen.ConstId:
						if (v.type !== binaryen.i32) refuse('non-i32 constant');
						return constant(v.value);
					case binaryen.LoadId: {
						const p = info(v.ptr);
						if (
							!this.allowByte ||
							v.bytes !== 1 ||
							v.isSigned ||
							v.offset !== 0 ||
							v.isAtomic ||
							p.id !== binaryen.LocalGetId ||
							p.index !== PTR
						)
							refuse('load other than the input byte');
						return byteBits();
					}
					case binaryen.BinaryId: {
						const a = this.symbolic(v.left);
						const b = this.symbolic(v.right);
						const left = info(v.left);
						const right = info(v.right);
						if (v.op === binaryen.XorInt32) return a.map((bit, k) => bit ^ b[k]!);
						if (right.id === binaryen.ConstId) {
							const shift = right.value & 31;
							if (v.op === binaryen.ShrUInt32)
								return a.map((_, k) => a[k + shift] ?? 0n);
							if (v.op === binaryen.ShrSInt32)
								return a.map((_, k) => a[k + shift] ?? a[W - 1]!);
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
							return Array(W).fill(b[0]);
						return refuse(`operation ${v.op}`);
					}
					case binaryen.BlockId: {
						if (v.name) refuse('named block in a value position');
						let result = constant(0);
						for (const child of v.children) result = this.symbolic(child);
						return result;
					}
					default:
						return refuse(`expression ${v.id}`);
				}
			}
		}

		// shape: block { br_if (eqz len); pre...; loop {...}; post... }; local.get 0
		const top = info(fn.body);
		if (top.id !== binaryen.BlockId || top.children.length !== 2) refuse('function shape');
		const ret = info(top.children[1]);
		if (ret.id !== binaryen.LocalGetId || ret.index !== 0) refuse('does not return the state');
		const guard = info(top.children[0]);
		if (guard.id !== binaryen.BlockId || !guard.name) refuse('no zero-length exit block');
		const parts: number[] = guard.children;
		const first = info(parts[0]!);
		const cond = first.id === binaryen.BreakId ? info(first.condition) : undefined;
		if (
			!cond ||
			first.name !== guard.name ||
			cond.id !== binaryen.UnaryId ||
			cond.op !== binaryen.EqZInt32 ||
			info(cond.value).id !== binaryen.LocalGetId ||
			info(cond.value).index !== LEN
		)
			refuse('zero-length exit is not br_if (eqz len)');
		const at = parts.findIndex((p, i) => i > 0 && info(p).id === binaryen.LoopId);
		if (at < 0) refuse('no loop');
		if (parts.slice(at + 1).some((p) => info(p).id === binaryen.LoopId)) refuse('second loop');

		const evalStatements = (statements: number[], seed: Bits) => {
			const ctx = new Ctx(false);
			ctx.locals[0] = seed;
			for (const s of statements) {
				const v = info(s);
				if (v.id !== binaryen.LocalSetId || v.index !== 0)
					refuse('statement outside the state');
				ctx.symbolic(s);
			}
			return ctx.locals[0]!;
		};
		const pre = evalStatements(parts.slice(1, at), unit(0));
		const post = evalStatements(parts.slice(at + 1), unit(0));

		const loop = info(parts[at]!);
		const loopBody = info(loop.body);
		const statements: number[] =
			loopBody.id === binaryen.BlockId ? loopBody.children : [loop.body];
		if (statements.length < 3) refuse('loop too short');
		const incr = info(statements[statements.length - 2]!);
		const back = info(statements[statements.length - 1]!);
		const isAdd = (expr: number, index: number, amount: number) => {
			const e = info(expr);
			return (
				e.id === binaryen.BinaryId &&
				e.op === binaryen.AddInt32 &&
				info(e.left).id === binaryen.LocalGetId &&
				info(e.left).index === index &&
				info(e.right).id === binaryen.ConstId &&
				info(e.right).value === amount
			);
		};
		if (incr.id !== binaryen.LocalSetId || incr.index !== PTR || !isAdd(incr.value, PTR, 1))
			refuse('pointer does not advance by one byte');
		const test = back.id === binaryen.BreakId ? info(back.condition) : undefined;
		if (
			!test ||
			back.name !== loop.name ||
			test.id !== binaryen.LocalSetId ||
			test.index !== LEN ||
			!isAdd(test.value, LEN, -1)
		)
			refuse('length does not count down to the back edge');
		const ctx = new Ctx(true);
		ctx.locals[0] = unit(0);
		for (const s of statements.slice(0, -2)) {
			const v = info(s);
			if (v.id !== binaryen.LocalSetId) refuse('statement kind in the loop');
			ctx.symbolic(s);
		}
		const step = ctx.locals[0]!;
		// the step may not use bits outside the state and byte variables except its constant
		const operator = Array.from({ length: W }, (_, k) =>
			step.reduce(
				(out, coefficients, output) =>
					out | (((coefficients >> BigInt(k)) & 1n) << BigInt(output)),
				0n
			)
		);
		// conditioning pair: pre and post are state xor a constant, and they cancel
		const mask = (1n << BigInt(W)) - 1n;
		const asXor = (bits: Bits, name: string) => {
			let c = 0n;
			bits.forEach((coefficients, k) => {
				if ((coefficients & mask) !== 1n << BigInt(k))
					refuse(`${name} is not a state xor constant`);
				if (
					coefficients >> BigInt(W) !== 0n &&
					coefficients >> BigInt(W) !== CONST >> BigInt(W)
				)
					refuse(`${name} depends on the byte`);
				if (coefficients & CONST) c |= 1n << BigInt(k);
			});
			return c;
		};
		const cPre = asXor(pre, 'conditioning before the loop');
		const cPost = asXor(post, 'conditioning after the loop');
		if (cPre !== cPost) refuse('conditioning does not cancel across calls');
		const model: AffineModel = {
			kind: 'model',
			ring: 'gf2',
			bits: W,
			align: 1,
			layout: { entry, state: 0, ptr: 1, len: 2, bits: W },
			operator,
			calls: 0,
			checks: []
		};
		return {
			model,
			conditioning: cPre,
			evidence: {
				moduleSha256: createHash('sha256').update(bytes).digest('hex'),
				schema: 'experimental-conditioned-byte-loop-v1',
				note: 'single pure loop, one byte load, pointer and length used only as loop control, pre and post are the same state xor constant'
			}
		};
	} finally {
		module.dispose();
	}
}

export const refusalOf = (bytes: Uint8Array, entry?: string) => {
	try {
		checkLoop(bytes, entry);
		return undefined;
	} catch (error) {
		if (error instanceof Refusal) return error.message;
		throw error;
	}
};
assert.ok(refusalOf);
