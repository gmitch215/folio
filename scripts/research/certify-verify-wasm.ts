// a small WebAssembly decoder for the certificate verifier; it shares nothing with binaryen

export interface Instr {
	op: number;
	a: number | bigint;
	b: number;
	c: number;
	// block types: parameter and result counts
	np: number;
	nr: number;
}

export interface FuncType {
	params: number[];
	results: number[];
}

export interface Func {
	type: FuncType;
	locals: number[];
	code: Instr[];
}

export interface WModule {
	types: FuncType[];
	funcs: Func[];
	exports: Map<string, { kind: number; index: number }>;
	memories: number;
	initialPages: number;
	globals: { type: number; mutable: boolean; init: bigint }[];
	start: number | undefined;
	data: { offset: number; bytes: Uint8Array }[];
	imports: number;
}

export class DecodeError extends Error {}

class Reader {
	pos = 0;
	readonly b: Uint8Array;
	constructor(b: Uint8Array) {
		this.b = b;
	}
	byte(): number {
		if (this.pos >= this.b.length) throw new DecodeError('unexpected end');
		return this.b[this.pos++]!;
	}
	u(): number {
		let v = 0;
		let shift = 0;
		for (;;) {
			const x = this.byte();
			v += (x & 127) * 2 ** shift;
			shift += 7;
			if (!(x & 128)) return v;
			if (shift > 63) throw new DecodeError('leb too long');
		}
	}
	s(bits: number): bigint {
		let v = 0n;
		let shift = 0n;
		let x: number;
		do {
			x = this.byte();
			v |= BigInt(x & 127) << shift;
			shift += 7n;
		} while (x & 128);
		if (x & 64 && shift < 128n) v |= -1n << shift;
		return BigInt.asIntN(bits, v);
	}
	name(): string {
		const n = this.u();
		const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
		this.pos += n;
		return s;
	}
	end() {
		return this.pos >= this.b.length;
	}
}

function constExpr(r: Reader): bigint {
	const op = r.byte();
	let v: bigint;
	if (op === 0x41) v = BigInt.asUintN(32, r.s(32));
	else if (op === 0x42) v = BigInt.asUintN(64, r.s(64));
	else throw new DecodeError('offset is not a plain constant');
	if (r.byte() !== 0x0b) throw new DecodeError('offset is not a plain constant');
	return v;
}

export function decode(bytes: Uint8Array): WModule {
	if (
		bytes.length < 8 ||
		bytes[0] !== 0 ||
		bytes[1] !== 0x61 ||
		bytes[2] !== 0x73 ||
		bytes[3] !== 0x6d
	)
		throw new DecodeError('bad magic');
	const r = new Reader(bytes);
	r.pos = 8;
	const m: WModule = {
		types: [],
		funcs: [],
		exports: new Map(),
		memories: 0,
		initialPages: 0,
		globals: [],
		start: undefined,
		data: [],
		imports: 0
	};
	let typeIdx: number[] = [];
	while (!r.end()) {
		const id = r.byte();
		const size = r.u();
		const end = r.pos + size;
		const s = new Reader(bytes.subarray(0, end));
		s.pos = r.pos;
		if (id === 1) {
			for (let n = s.u(); n > 0; n--) {
				if (s.byte() !== 0x60) throw new DecodeError('bad type');
				const params = Array.from({ length: s.u() }, () => s.byte());
				const results = Array.from({ length: s.u() }, () => s.byte());
				m.types.push({ params, results });
			}
		} else if (id === 2) {
			m.imports = s.u();
		} else if (id === 3) {
			typeIdx = Array.from({ length: s.u() }, () => s.u());
		} else if (id === 5) {
			m.memories = s.u();
			if (m.memories >= 1) {
				const flags = s.u();
				m.initialPages = s.u();
				if (flags & 1) s.u();
			}
		} else if (id === 6) {
			for (let n = s.u(); n > 0; n--) {
				const type = s.byte();
				const mutable = s.byte() === 1;
				m.globals.push({ type, mutable, init: constExpr(s) });
			}
		} else if (id === 7) {
			for (let n = s.u(); n > 0; n--) {
				const name = s.name();
				m.exports.set(name, { kind: s.byte(), index: s.u() });
			}
		} else if (id === 8) {
			m.start = s.u();
		} else if (id === 10) {
			const count = s.u();
			for (let i = 0; i < count; i++) {
				const bodySize = s.u();
				const bodyEnd = s.pos + bodySize;
				const locals: number[] = [];
				for (let g = s.u(); g > 0; g--) {
					const k = s.u();
					const t = s.byte();
					if (k > 50000) throw new DecodeError('too many locals');
					for (let j = 0; j < k; j++) locals.push(t);
				}
				const type = m.types[typeIdx[i]!];
				if (!type) throw new DecodeError('bad function type');
				m.funcs.push({ type, locals, code: instrs(s, bodyEnd, m) });
				s.pos = bodyEnd;
			}
		} else if (id === 11) {
			for (let n = s.u(); n > 0; n--) {
				const flag = s.u();
				if (flag !== 0) throw new DecodeError('only active segments of memory zero');
				const offset = Number(constExpr(s));
				const len = s.u();
				m.data.push({ offset, bytes: bytes.slice(s.pos, s.pos + len) });
				s.pos += len;
			}
		}
		r.pos = end;
	}
	return m;
}

function blockType(s: Reader, m: WModule): { np: number; nr: number } {
	const first = s.b[s.pos]!;
	if (first === 0x40) {
		s.pos++;
		return { np: 0, nr: 0 };
	}
	if (first === 0x7f || first === 0x7e || first === 0x7d || first === 0x7c) {
		s.pos++;
		return { np: 0, nr: 1 };
	}
	const t = m.types[Number(s.s(33))];
	if (!t) throw new DecodeError('bad block type');
	return { np: t.params.length, nr: t.results.length };
}

function instrs(s: Reader, end: number, m: WModule): Instr[] {
	const out: Instr[] = [];
	const open: number[] = [];
	const push = (op: number, a: number | bigint = 0, b = 0, c = 0, np = 0, nr = 0) =>
		out.push({ op, a, b, c, np, nr });
	while (s.pos < end) {
		const op = s.byte();
		switch (op) {
			case 0x02:
			case 0x03:
			case 0x04: {
				const t = blockType(s, m);
				open.push(out.length);
				push(op, 0, 0, 0, t.np, t.nr);
				break;
			}
			case 0x05: {
				const top = open[open.length - 1];
				if (top === undefined) throw new DecodeError('bad else');
				out[top]!.b = out.length;
				push(op);
				break;
			}
			case 0x0b: {
				const top = open.pop();
				if (top !== undefined) out[top]!.a = out.length;
				push(op);
				break;
			}
			case 0x0c:
			case 0x0d:
				push(op, s.u());
				break;
			case 0x0e: {
				const n = s.u();
				const labels = Array.from({ length: n + 1 }, () => s.u());
				push(op, 0, 0, 0);
				(out[out.length - 1] as Instr & { labels?: number[] }).labels = labels;
				break;
			}
			case 0x10:
				push(op, s.u());
				break;
			case 0x20:
			case 0x21:
			case 0x22:
			case 0x23:
			case 0x24:
				push(op, s.u());
				break;
			case 0x41:
				push(op, BigInt.asUintN(32, s.s(32)));
				break;
			case 0x42:
				push(op, BigInt.asUintN(64, s.s(64)));
				break;
			case 0x3f:
			case 0x40:
				s.byte();
				push(op);
				break;
			case 0xfc: {
				const sub = s.u();
				if (sub === 10) {
					s.byte();
					s.byte();
				} else if (sub === 11) s.byte();
				else if (sub > 7) s.u();
				push(0xfc00 + sub);
				break;
			}
			default:
				if (op >= 0x28 && op <= 0x3e) {
					s.u();
					push(op, s.u());
				} else push(op);
		}
	}
	if (open.length) throw new DecodeError('unclosed block');
	return out;
}
