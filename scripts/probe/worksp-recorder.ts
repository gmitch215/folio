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
}

export interface RecorderOptions {
	layout: Layout;
	/** label for a frame pointer, called once per invocation entry */
	nameOf?: (frame: number) => string;
}

/** turns dispatch events, counter readings and memory accesses into work-span nodes */
export class Recorder {
	readonly ws: WorkSpan;
	private shift: number;
	private stack: Invocation[] = [];
	private open: boolean[] = [];
	private reads = Array.from({ length: 5 }, () => new AccessBuf());
	private writes = Array.from({ length: 5 }, () => new AccessBuf());
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
		emptyChunksSkipped: 0
	};

	constructor(options: RecorderOptions) {
		this.ws = new WorkSpan(options.layout, (q, c) => q === c || q > c || this.open[q] === true);
		this.shift = this.ws.shift;
		this.nameOf = options.nameOf ?? ((frame) => `frame ${frame}`);
		this.open[0] = true;
		this.stack.push({ id: 0, frame: -1, prev: -1, childJoins: [], label: 'request' });
	}

	/** call with the cumulative counters at the start of the measured request */
	start(ic: number, spr = 0, spw = 0) {
		this.lastIc = ic;
		this.lastSpr = spr;
		this.lastSpw = spw;
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
		const node: WNode = {
			weight: this.weight,
			preds: inv.prev >= 0 ? [inv.prev] : [],
			inv: inv.id,
			reads,
			writes,
			sp: this.sp,
			host: this.hostCalls,
			label: inv.label
		};
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
	dispatch(frame: number, ic: number, spr = 0, spw = 0) {
		this.take(ic, spr, spw);
		this.stats.dispatches++;
		if (this.outDepth > 0) this.stats.outputExtentDispatches++;
		let top = this.stack[this.stack.length - 1]!;
		const fresh = this.entry;
		this.entry = false;
		if (fresh && frame === top.frame && this.stack.length > 1) {
			this.pop();
			top = this.stack[this.stack.length - 1]!;
		} else if (frame === top.frame) return;
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
		const inv: Invocation = {
			id: this.nextInv++,
			frame,
			prev: top.prev,
			childJoins: [],
			label: this.nameOf(frame)
		};
		this.open[inv.id] = true;
		this.stack.push(inv);
		this.stats.invocations++;
		this.stats.maxDepth = Math.max(this.stats.maxDepth, this.stack.length - 1);
	}

	/** execute_ex was entered from C: the next dispatch starts a new invocation */
	markEntry() {
		this.entry = true;
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
		const cat =
			this.allocDepth > 0
				? CAT.alloc
				: siteCat === CAT.rc
					? CAT.rc
					: this.outDepth > 0
						? CAT.out
						: CAT.plain;
		const lo = addr >>> this.shift;
		const hi = (addr + size - 1) >>> this.shift;
		(store ? this.writes : this.reads)[cat]!.push(lo, hi);
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
