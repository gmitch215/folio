import { cbin, cun, refuse, type Form, type Ring, type W } from './certify-verify-rings.ts';
import type { Instr, WModule } from './certify-verify-wasm.ts';

// a concrete-control, symbolic-data interpreter over the decoded module

export type Val = bigint | Form;

const isForm = (v: Val): v is Form => typeof v !== 'bigint';

export class Mem {
	over = new Map<number, Val>();
	own: [number, number] = [0, 0];
	origin = 0;
	allowed: ((a: number) => boolean) | undefined;
	reads = new Set<number>();
	writes = new Map<number, bigint>();
	wrote = new Set<number>();
	wroteOwn = false;
	dirty = false;

	readonly ring: Ring;
	readonly base: Uint8Array;
	readonly size: number;

	constructor(ring: Ring, base: Uint8Array, size: number) {
		this.ring = ring;
		this.base = base;
		this.size = size;
	}

	// own is the input range; allowed limits the other addresses the call may touch
	begin(own: [number, number], origin: number, allowed?: (a: number) => boolean) {
		this.own = own;
		this.origin = origin;
		this.allowed = allowed;
		this.reads = new Set();
		this.writes = new Map();
		this.wrote = new Set();
		this.wroteOwn = false;
	}

	private inOwn(a: number) {
		return a >= this.own[0] && a < this.own[1];
	}

	private outside(a: number) {
		if (this.allowed && !this.allowed(a)) refuse(`access outside the input at ${a}`);
	}

	read8(a: number): Val {
		if (a < 0 || a >= this.size) refuse('trap: read out of bounds');
		const own = this.inOwn(a);
		if (!own) {
			this.outside(a);
			if (!this.wrote.has(a)) this.reads.add(a);
		}
		const held = this.over.get(a);
		if (held !== undefined) return held;
		if (own) return this.ring.byte(a - this.origin);
		return BigInt(this.base[a] ?? 0);
	}

	readConcrete(a: number): number {
		if (a < 0 || a >= this.size) refuse('trap: table read out of bounds');
		if (this.inOwn(a)) refuse('a table lies in the input');
		this.outside(a);
		const held = this.over.get(a);
		if (held !== undefined) {
			if (isForm(held)) refuse('a table holds symbolic bytes');
			return Number(held);
		}
		return this.base[a] ?? 0;
	}

	noteReads(list: number[]) {
		for (const a of list) if (!this.wrote.has(a)) this.reads.add(a);
	}

	write8(a: number, v: Val) {
		if (a < 0 || a >= this.size) refuse('trap: write out of bounds');
		if (this.inOwn(a)) this.wroteOwn = true;
		else {
			this.outside(a);
			if (typeof v !== 'bigint') refuse('symbolic data written outside the input');
			this.writes.set(a, v as bigint);
			this.dirty = true;
		}
		this.over.set(a, v);
		this.wrote.add(a);
	}
}

// table lookups depend only on the form and on memory nobody wrote, so they repeat across calls
const tables = new WeakMap<Uint8Array, Map<string, { value: Form; reads: number[] }>>();

const LOADS: Record<number, [W, number, boolean]> = {
	0x28: [32, 4, false],
	0x29: [64, 8, false],
	0x2c: [32, 1, true],
	0x2d: [32, 1, false],
	0x2e: [32, 2, true],
	0x2f: [32, 2, false],
	0x30: [64, 1, true],
	0x31: [64, 1, false],
	0x32: [64, 2, true],
	0x33: [64, 2, false],
	0x34: [64, 4, true],
	0x35: [64, 4, false]
};
const STORES: Record<number, [W, number]> = {
	0x36: [32, 4],
	0x37: [64, 8],
	0x3a: [32, 1],
	0x3b: [32, 2],
	0x3c: [64, 1],
	0x3d: [64, 2],
	0x3e: [64, 4]
};

const ARITH = [
	'Add',
	'Sub',
	'Mul',
	'DivS',
	'DivU',
	'RemS',
	'RemU',
	'And',
	'Or',
	'Xor',
	'Shl',
	'ShrS',
	'ShrU',
	'RotL',
	'RotR'
];
const CMPS = ['Eq', 'Ne', 'LtS', 'LtU', 'GtS', 'GtU', 'LeS', 'LeU', 'GeS', 'GeU'];
const BIN = new Map<number, [string, W]>();
const UN = new Map<number, [string, W]>();
CMPS.forEach((op, i) => {
	BIN.set(0x46 + i, [op, 32]);
	BIN.set(0x51 + i, [op, 64]);
});
ARITH.forEach((op, i) => {
	BIN.set(0x6a + i, [op, 32]);
	BIN.set(0x7c + i, [op, 64]);
});
UN.set(0x45, ['EqZ', 32]);
UN.set(0x50, ['EqZ', 64]);
['Clz', 'Ctz', 'Popcnt'].forEach((op, i) => {
	UN.set(0x67 + i, [op, 32]);
	UN.set(0x79 + i, [op, 64]);
});
UN.set(0xa7, ['Wrap', 64]);
UN.set(0xac, ['ExtendS', 32]);
UN.set(0xad, ['ExtendU', 32]);
UN.set(0xc0, ['Extend8S', 32]);
UN.set(0xc1, ['Extend16S', 32]);
UN.set(0xc2, ['Extend8S', 64]);
UN.set(0xc3, ['Extend16S', 64]);
UN.set(0xc4, ['Extend32S', 64]);

interface Label {
	height: number;
	arity: number;
	loop: boolean;
	start: number;
	end: number;
}

export class Machine {
	steps = 0;
	readonly mod: WModule;
	readonly ring: Ring;
	readonly mem: Mem;
	readonly limit: number;

	constructor(mod: WModule, ring: Ring, mem: Mem, limit = 4_000_000) {
		this.mod = mod;
		this.ring = ring;
		this.mem = mem;
		this.limit = limit;
	}

	private norm(f: Form): Val {
		return this.ring.asConst(f) ?? f;
	}

	private lift(v: Val, w: W): Form {
		return typeof v === 'bigint' ? this.ring.konst(v, w) : v;
	}

	private bin(op: string, w: W, a: Val, b: Val): Val {
		if (typeof a === 'bigint' && typeof b === 'bigint') return cbin(op, w, a, b);
		if (
			typeof a !== 'bigint' &&
			typeof b !== 'bigint' &&
			this.ring.key(a) === this.ring.key(b)
		) {
			if (['Eq', 'LeU', 'GeU', 'LeS', 'GeS'].includes(op)) return 1n;
			if (['Ne', 'LtU', 'GtU', 'LtS', 'GtS'].includes(op)) return 0n;
		}
		return this.norm(this.ring.bin(op, w, this.lift(a, w), this.lift(b, w)));
	}

	private un(op: string, w: W, a: Val): Val {
		if (typeof a === 'bigint') return cun(op, w, a);
		return this.norm(this.ring.un(op, w, a));
	}

	private load(op: number, base: Val, offset: number): Val {
		const [w, bytes, signed] = LOADS[op]!;
		if (isForm(base)) {
			let cache = tables.get(this.mem.base);
			if (!cache) tables.set(this.mem.base, (cache = new Map()));
			const key = `${this.ring.name}|${this.ring.key(base)}|${offset}|${bytes}`;
			let r = this.mem.dirty ? undefined : cache.get(key);
			if (!r) {
				r = this.ring.lookup(
					base,
					offset,
					bytes,
					(a) => this.mem.readConcrete(a),
					this.mem.size
				);
				if (!this.mem.dirty) cache.set(key, r);
			}
			this.mem.noteReads(r.reads);
			let f = r.value;
			if (f.w !== w) f = this.ring.un(w === 64 ? 'ExtendU' : 'Wrap', f.w, f);
			if (signed && bytes * 8 < w) f = this.ring.un(`Extend${bytes * 8}S`, w, f);
			return this.norm(f);
		}
		const at = Number(base) + offset;
		if (at + bytes > this.mem.size) refuse('trap: load out of bounds');
		const parts: Val[] = [];
		for (let k = 0; k < bytes; k++) parts.push(this.mem.read8(at + k));
		if (parts.every((p) => typeof p === 'bigint')) {
			let v = 0n;
			parts.forEach((p, k) => (v |= (p as bigint) << BigInt(8 * k)));
			if (signed) v = BigInt.asUintN(w, BigInt.asIntN(bytes * 8, v));
			return v;
		}
		let f = this.ring.assemble(
			parts.map((p) => this.lift(p, 32)),
			w
		);
		if (signed && bytes * 8 < w) f = this.ring.un(`Extend${bytes * 8}S`, w, f);
		return this.norm(f);
	}

	private store(op: number, base: Val, offset: number, value: Val) {
		const [w, bytes] = STORES[op]!;
		if (isForm(base)) refuse('store to a symbolic address');
		const at = Number(base) + offset;
		if (at + bytes > this.mem.size) refuse('trap: store out of bounds');
		if (typeof value === 'bigint') {
			for (let k = 0; k < bytes; k++)
				this.mem.write8(at + k, (value >> BigInt(8 * k)) & 255n);
			return;
		}
		void w;
		const parts = this.ring.split(value, bytes);
		parts.forEach((p, k) => this.mem.write8(at + k, this.norm(p)));
	}

	call(index: number, args: Val[], depth = 0): Val[] {
		if (depth > 32) refuse('call depth');
		const fn = this.mod.funcs[index];
		if (!fn) refuse(`no function ${index}`);
		const f = fn!;
		const locals: Val[] = [...args, ...f.locals.map(() => 0n)];
		const stack: Val[] = [];
		const labels: Label[] = [
			{ height: 0, arity: f.type.results.length, loop: false, start: -1, end: f.code.length }
		];
		const code = f.code;
		let ip = 0;
		const pop = () => {
			const v = stack.pop();
			if (v === undefined) refuse('stack underflow');
			return v!;
		};
		const cond = (v: Val) => {
			if (typeof v !== 'bigint') refuse('a branch depends on a symbolic value');
			return (v as bigint) !== 0n;
		};
		const branch = (depth: number) => {
			const at = labels.length - 1 - depth;
			const target = labels[at];
			if (!target) refuse('bad branch');
			const t = target!;
			const keep = t.arity;
			const moved = keep ? stack.splice(stack.length - keep) : [];
			stack.length = t.height;
			stack.push(...moved);
			if (t.loop) {
				labels.length = at + 1;
				ip = t.start + 1;
			} else {
				labels.length = at;
				ip = t.end + 1;
			}
		};
		while (ip < code.length) {
			if (++this.steps > this.limit) refuse('step limit');
			const ins: Instr = code[ip]!;
			const op = ins.op;
			ip++;
			switch (op) {
				case 0x00:
					refuse('trap: unreachable');
					break;
				case 0x01:
					break;
				case 0x02:
					labels.push({
						height: stack.length - ins.np,
						arity: ins.nr,
						loop: false,
						start: ip - 1,
						end: ins.a as number
					});
					break;
				case 0x03:
					labels.push({
						height: stack.length - ins.np,
						arity: ins.np,
						loop: true,
						start: ip - 1,
						end: ins.a as number
					});
					break;
				case 0x04: {
					const c = cond(pop());
					labels.push({
						height: stack.length - ins.np,
						arity: ins.nr,
						loop: false,
						start: ip - 1,
						end: ins.a as number
					});
					if (!c) ip = ins.b ? ins.b + 1 : (ins.a as number);
					break;
				}
				case 0x05:
					ip = labels[labels.length - 1]!.end;
					break;
				case 0x0b:
					labels.pop();
					break;
				case 0x0c:
					branch(ins.a as number);
					break;
				case 0x0d:
					if (cond(pop())) branch(ins.a as number);
					break;
				case 0x0e: {
					const v = pop();
					if (typeof v !== 'bigint') refuse('a branch depends on a symbolic value');
					const labelsList = (ins as Instr & { labels: number[] }).labels;
					const k = Number(v as bigint);
					branch(labelsList[Math.min(k, labelsList.length - 1)]!);
					break;
				}
				case 0x0f:
					ip = code.length;
					labels.length = 0;
					break;
				case 0x10: {
					const callee = this.mod.funcs[ins.a as number];
					if (!callee) refuse('call to an unknown function');
					const n = callee!.type.params.length;
					const a = stack.splice(stack.length - n);
					stack.push(...this.call(ins.a as number, a, depth + 1));
					break;
				}
				case 0x1a:
					pop();
					break;
				case 0x1b:
				case 0x1c: {
					const c = pop();
					const b = pop();
					const a = pop();
					if (typeof c === 'bigint') stack.push(c !== 0n ? a : b);
					else {
						const wide = [a, b].some((x) =>
							typeof x === 'bigint' ? x >> 32n !== 0n : x.w === 64
						);
						const w: W = wide ? 64 : 32;
						stack.push(
							this.norm(this.ring.select(w, this.lift(a, w), this.lift(b, w), c))
						);
					}
					break;
				}
				case 0x20:
					stack.push(locals[ins.a as number]!);
					break;
				case 0x21:
					locals[ins.a as number] = pop();
					break;
				case 0x22:
					locals[ins.a as number] = stack[stack.length - 1]!;
					break;
				case 0x23: {
					const g = this.mod.globals[ins.a as number];
					if (!g) refuse('unknown global');
					if (g!.type !== 0x7f && g!.type !== 0x7e) refuse('float global');
					stack.push(g!.init);
					break;
				}
				case 0x24:
					refuse('the function writes a global');
					break;
				case 0x41:
				case 0x42:
					stack.push(ins.a as bigint);
					break;
				case 0x3f:
				case 0x40:
					refuse('memory.size and memory.grow are not supported');
					break;
				case 0xfc0a: {
					const n = pop();
					const s = pop();
					const d = pop();
					if ([n, s, d].some(isForm)) refuse('memory.copy with a symbolic operand');
					const [nn, ss, dd] = [Number(n), Number(s), Number(d)];
					if (nn > 1 << 20) refuse('memory.copy too long');
					if (ss + nn > this.mem.size || dd + nn > this.mem.size)
						refuse('trap: memory.copy');
					const tmp = Array.from({ length: nn }, (_, k) => this.mem.read8(ss + k));
					tmp.forEach((v, k) => this.mem.write8(dd + k, v));
					break;
				}
				case 0xfc0b: {
					const n = pop();
					const v = pop();
					const d = pop();
					if ([n, d].some(isForm)) refuse('memory.fill with a symbolic operand');
					const nn = Number(n);
					const dd = Number(d);
					if (nn > 1 << 20) refuse('memory.fill too long');
					if (dd + nn > this.mem.size) refuse('trap: memory.fill');
					for (let k = 0; k < nn; k++)
						this.mem.write8(
							dd + k,
							isForm(v) ? refuse('memory.fill of a symbolic byte') : v & 255n
						);
					break;
				}
				default: {
					if (LOADS[op]) {
						stack.push(this.load(op, pop(), ins.a as number));
						break;
					}
					if (STORES[op]) {
						const value = pop();
						const base = pop();
						this.store(op, base, ins.a as number, value);
						break;
					}
					const b = BIN.get(op);
					if (b) {
						const y = pop();
						const x = pop();
						stack.push(this.bin(b[0], b[1], x, y));
						break;
					}
					const u = UN.get(op);
					if (u) {
						stack.push(this.un(u[0], u[1], pop()));
						break;
					}
					refuse(`unsupported instruction 0x${op.toString(16)}`);
				}
			}
		}
		return stack.slice(stack.length - f.type.results.length);
	}
}
