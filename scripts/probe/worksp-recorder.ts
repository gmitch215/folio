import { CAT, WorkSpan, type Layout, type WNode } from '../analyze/worksp.ts';

const SPAN = 2 ** 26;

class AccessBuf {
	a = new Float64Array(256);
	n = 0;
	lo = -1;
	hi = -1;
	push(lo: number, hi: number) {
		if (lo === this.lo && hi === this.hi) return;
		this.lo = lo;
		this.hi = hi;
		for (let start = lo; start <= hi; start += SPAN) {
			const end = Math.min(hi, start + SPAN - 1);
			if (this.n === this.a.length) {
				const b = new Float64Array(this.a.length * 2);
				b.set(this.a);
				this.a = b;
			}
			this.a[this.n++] = start * SPAN + (end - start);
		}
	}
	/** sorted, merged [lo, hi] pairs appended to out with the category */
	drain(cat: number, out: number[]) {
		if (this.n === 0) return;
		const keys = this.a.subarray(0, this.n).sort();
		let lo = Math.floor(keys[0]! / SPAN);
		let hi = lo + (keys[0]! % SPAN);
		for (let i = 1; i < keys.length; i++) {
			const l = Math.floor(keys[i]! / SPAN);
			const h = l + (keys[i]! % SPAN);
			if (l <= hi + 1) hi = Math.max(hi, h);
			else {
				out.push(lo, hi, cat);
				lo = l;
				hi = h;
			}
		}
		out.push(lo, hi, cat);
		this.n = 0;
		this.lo = -1;
		this.hi = -1;
	}
}

interface Invocation {
	id: number;
	frame: number;
	prev: number;
	childJoins: number[];
	label: string;
	/** every opcode of this invocation is its own node */
	fine: boolean;
	started: boolean;
}

export interface RecorderOptions {
	layout: Layout;
	/** label for a frame pointer, called once per invocation entry */
	nameOf?: (frame: number) => string;
	/** drop a read of a word the same chunk already wrote (default true) */
	exposure?: boolean;
	/** drop an upward-exposed read of stack words below the chunk's starting stack pointer (default true) */
	deadStack?: boolean;
	/** invocations whose opcodes become separate nodes */
	fine?: (label: string) => boolean;
	/** log every stack RAW edge between unrelated invocations for grouping */
	stackLog?: boolean;
}

/** turns dispatch events, counter readings and memory accesses into work-span nodes */
export class Recorder {
	readonly ws: WorkSpan;
	private shift: number;
	private stack: Invocation[] = [];
	private open: boolean[] = [];
	private reads = Array.from({ length: 6 }, () => new AccessBuf());
	private writes = Array.from({ length: 6 }, () => new AccessBuf());
	private weight = 0;
	private sp = 0;
	private hostCalls = 0;
	private used = false;
	private lastIc = 0;
	private lastSpr = 0;
	private lastSpw = 0;
	private allocDepth = 0;
	private outDepth = 0;
	private nextInv = 1;
	private entry = false;
	actLog: { base: number; top: number; bottom: number }[] = [];
	private acts: { base: number; top: number; bottom: number }[] = [];
	private exposure: boolean;
	private deadStack: boolean;
	private fine: (label: string) => boolean;
	private stackRange: [number, number];
	private chunkNo = 1;
	private chunkOp = -1;
	private stamp = new Uint32Array(1 << 20);
	private mask = new Uint8Array(1 << 20);
	private curSp = 0;
	private sp0 = 0;
	nameOf: (frame: number) => string;
	stats = {
		dispatches: 0,
		invocations: 0,
		maxDepth: 0,
		popped: 0,
		hostCalls: 0,
		outputExtents: 0,
		outputExtentDispatches: 0,
		accesses: 0,
		emptyChunksSkipped: 0,
		ownWriteReads: 0,
		deadStackReads: 0,
		opcodeChunks: 0
	};

	constructor(options: RecorderOptions) {
		this.ws = new WorkSpan(options.layout, (q, c) => q === c || q > c || this.open[q] === true);
		this.shift = this.ws.shift;
		if (this.shift !== 3) throw new Error('the recorder needs 8-byte granules');
		this.exposure = options.exposure ?? true;
		this.deadStack = options.deadStack ?? true;
		this.fine = options.fine ?? (() => false);
		this.stackRange = options.layout.stack;
		if (options.stackLog) {
			this.ws.stackLog = [];
			this.ws.stackHist = new Map();
		}
		this.nameOf = options.nameOf ?? ((frame) => `frame ${frame}`);
		this.open[0] = true;
		this.stack.push({
			id: 0,
			frame: -1,
			prev: -1,
			childJoins: [],
			label: 'request',
			fine: false,
			started: false
		});
	}

	/** call with the cumulative counters and the stack pointer at the start of the measured request */
	start(ic: number, spr = 0, spw = 0, sp = 0) {
		this.lastIc = ic;
		this.lastSpr = spr;
		this.lastSpw = spw;
		this.curSp = sp;
		this.sp0 = sp;
	}

	private take(ic: number, spr: number, spw: number) {
		if (ic !== this.lastIc) this.used = true;
		this.weight += ic - this.lastIc;
		if (spr !== this.lastSpr) this.sp |= 1;
		if (spw !== this.lastSpw) this.sp |= 2;
		this.lastIc = ic;
		this.lastSpr = spr;
		this.lastSpw = spw;
	}

	private chunk() {
		const out: number[] = [];
		return { reads: this.drain(this.reads, out), writes: this.drain(this.writes, []) };
	}

	private drain(bufs: AccessBuf[], out: number[]) {
		for (let c = 0; c < bufs.length; c++) bufs[c]!.drain(c, out);
		return out;
	}

	private commitChunk(inv: Invocation) {
		const { reads, writes } = this.chunk();
		this.chunkNo++;
		this.sp0 = this.curSp;
		if (
			!this.used &&
			reads.length === 0 &&
			writes.length === 0 &&
			this.sp === 0 &&
			!this.hostCalls
		) {
			this.stats.emptyChunksSkipped++;
			return;
		}
		const ordered = inv.fine && inv.started;
		const node: WNode = {
			weight: this.weight,
			preds: !ordered && inv.prev >= 0 ? [inv.prev] : [],
			order: ordered && inv.prev >= 0 ? [inv.prev] : undefined,
			inv: inv.id,
			reads,
			writes,
			sp: this.sp,
			host: this.hostCalls,
			label: inv.label,
			op: this.chunkOp
		};
		if (inv.fine) this.stats.opcodeChunks++;
		inv.started = true;
		inv.prev = this.ws.add(node);
		this.weight = 0;
		this.sp = 0;
		this.hostCalls = 0;
		this.used = false;
	}

	private pop() {
		const inv = this.stack.pop()!;
		this.commitChunk(inv);
		const preds = [...(inv.prev >= 0 ? [inv.prev] : []), ...inv.childJoins];
		const join = this.ws.add({
			weight: 0,
			preds,
			inv: inv.id,
			reads: [],
			writes: [],
			join: true,
			label: `join ${inv.label}`
		});
		this.open[inv.id] = false;
		this.stack[this.stack.length - 1]!.childJoins.push(join);
		this.stats.popped++;
	}

	/** the frame (execute_data) the interpreter dispatches an opcode handler in */
	dispatch(frame: number, ic: number, spr = 0, spw = 0, sp = 0, op = -1) {
		this.dispatchInner(frame, ic, spr, spw, sp);
		this.chunkOp = op;
	}

	private dispatchInner(frame: number, ic: number, spr: number, spw: number, sp: number) {
		this.take(ic, spr, spw);
		this.curSp = sp;
		const act = this.acts[this.acts.length - 1];
		if (act && act.bottom === 0) act.bottom = sp;
		this.stats.dispatches++;
		if (this.outDepth > 0) this.stats.outputExtentDispatches++;
		let top = this.stack[this.stack.length - 1]!;
		const fresh = this.entry;
		this.entry = false;
		if (fresh && frame === top.frame && this.stack.length > 1) {
			this.pop();
			top = this.stack[this.stack.length - 1]!;
		} else if (frame === top.frame) {
			if (top.fine) this.commitChunk(top);
			return;
		}
		let depth = -1;
		for (let i = this.stack.length - 2; i >= 1; i--)
			if (this.stack[i]!.frame === frame) {
				depth = i;
				break;
			}
		if (depth >= 0) {
			while (this.stack.length - 1 > depth) this.pop();
			return;
		}
		this.commitChunk(top);
		const label = this.nameOf(frame);
		const inv: Invocation = {
			id: this.nextInv++,
			frame,
			prev: top.prev,
			childJoins: [],
			label,
			fine: this.fine(label),
			started: false
		};
		this.ws.registerInv(inv.id, top.id, label);
		this.open[inv.id] = true;
		this.stack.push(inv);
		this.stats.invocations++;
		this.stats.maxDepth = Math.max(this.stats.maxDepth, this.stack.length - 1);
	}

	/** execute_ex was entered from C: the next dispatch starts a new invocation */
	markEntry() {
		this.entry = true;
	}

	/** an interpreter activation begins; its invocations are the stack entries created from here on */
	enterExec(sp = 0) {
		const act = { base: this.stack.length, top: sp, bottom: 0 };
		this.acts.push(act);
		if (this.ws.stackHist && this.actLog.length < 6) this.actLog.push(act);
	}

	/**
	 * the activation returned to C: its invocations end here, so the caller's code that runs before the next
	 * dispatch (array_map between two callbacks, say) is charged to the caller and not to the last callback
	 */
	exitExec(ic: number, spr = 0, spw = 0, sp = 0) {
		this.take(ic, spr, spw);
		this.curSp = sp;
		const act = this.acts.pop();
		if (act === undefined) return;
		while (this.stack.length > Math.max(act.base, 1)) this.pop();
	}

	enter(kind: 'alloc' | 'out') {
		if (kind === 'alloc') this.allocDepth++;
		else {
			if (this.outDepth === 0) this.stats.outputExtents++;
			this.outDepth++;
		}
	}

	exit(kind: 'alloc' | 'out') {
		if (kind === 'alloc') this.allocDepth = Math.max(0, this.allocDepth - 1);
		else this.outDepth = Math.max(0, this.outDepth - 1);
	}

	host() {
		this.hostCalls++;
		this.stats.hostCalls++;
	}

	/** siteCat is CAT.rc for a verified refcount site, otherwise CAT.plain */
	access(addr: number, size: number, store: boolean, siteCat = CAT.plain) {
		this.stats.accesses++;
		let cat =
			this.allocDepth > 0
				? CAT.alloc
				: siteCat === CAT.rc
					? CAT.rc
					: this.outDepth > 0
						? CAT.out
						: CAT.plain;
		if (cat === CAT.plain) {
			const act = this.acts[this.acts.length - 1];
			if (act && act.bottom > 0 && addr >= act.bottom && addr < act.top) cat = CAT.interp;
			else if (size === 4 && this.isOpline(addr)) cat = CAT.interp;
		}
		const lo = addr >>> this.shift;
		const hi = (addr + size - 1) >>> this.shift;
		if (store) {
			if (this.exposure) this.stampWrite(addr, size, lo, hi);
			this.writes[cat]!.push(lo, hi);
		} else if ((!this.exposure && !this.deadStack) || hi - lo > 64)
			this.reads[cat]!.push(lo, hi);
		else this.filteredRead(addr, size, cat, lo, hi);
	}

	inAlloc() {
		return this.allocDepth;
	}

	/** the opline field (offset 0) of the running frame or its caller: the interpreter's program counter */
	private isOpline(addr: number) {
		const n = this.stack.length;
		return addr === this.stack[n - 1]!.frame || (n > 1 && addr === this.stack[n - 2]!.frame);
	}

	private grow(g: number) {
		let n = this.stamp.length;
		while (n <= g) n *= 2;
		const stamp = new Uint32Array(n);
		const mask = new Uint8Array(n);
		stamp.set(this.stamp);
		mask.set(this.mask);
		this.stamp = stamp;
		this.mask = mask;
	}

	private byteMask(addr: number, size: number, g: number) {
		const gs = g * 8;
		const a = Math.max(addr, gs) - gs;
		const b = Math.min(addr + size, gs + 8) - gs;
		return ((1 << (b - a)) - 1) << a;
	}

	private stampWrite(addr: number, size: number, lo: number, hi: number) {
		if (hi - lo > 1 << 16) return;
		if (hi >= this.stamp.length) this.grow(hi);
		for (let g = lo; g <= hi; g++) {
			const m = this.byteMask(addr, size, g);
			if (this.stamp[g] !== this.chunkNo) {
				this.stamp[g] = this.chunkNo;
				this.mask[g] = m;
			} else this.mask[g]! |= m;
		}
	}

	/** an upward-exposed read: not preceded by a write of the same bytes in this chunk, and not dead stack */
	private filteredRead(addr: number, size: number, cat: number, lo: number, hi: number) {
		const [stackLo, stackHi] = this.stackRange;
		const dead = this.deadStack && this.sp0 > 0;
		for (let g = lo; g <= hi; g++) {
			if (this.exposure && g < this.stamp.length && this.stamp[g] === this.chunkNo) {
				const m = this.byteMask(addr, size, g);
				if ((this.mask[g]! & m) === m) {
					this.stats.ownWriteReads++;
					continue;
				}
			}
			if (dead && g * 8 >= stackLo && g * 8 < stackHi && (g + 1) * 8 <= this.sp0) {
				this.stats.deadStackReads++;
				continue;
			}
			this.reads[cat]!.push(g, g);
		}
	}

	/** closes every open invocation; returns the analyzer */
	finish(ic: number, spr = 0, spw = 0) {
		this.take(ic, spr, spw);
		while (this.stack.length > 1) this.pop();
		this.commitChunk(this.stack[0]!);
		this.ws.checks.outOtherWrites += this.stats.outputExtentDispatches;
		return this.ws;
	}
}
