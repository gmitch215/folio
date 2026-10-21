import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256 } from './lib.ts';

export const CLASS_NAMES = [
	'spawn',
	'stack',
	'static',
	'allocator',
	'refcount',
	'output',
	'host',
	'heap'
] as const;
export const K = {
	spawn: 0,
	stack: 1,
	static: 2,
	allocator: 3,
	refcount: 4,
	output: 5,
	host: 6,
	heap: 7
};
export const CAT = { plain: 0, alloc: 1, rc: 2, out: 3, outOther: 4 };
const RAW = 0;
const WAR = 1;
const WAW = 2;
const bit = (cls: number, kind: number) => 1 << (cls * 3 + kind);
const KIND_ALL = [RAW, WAR, WAW];
const classBits = (cls: number) => KIND_ALL.reduce((m, k) => m | bit(cls, k), 0);
const MEM_CLASSES = [K.stack, K.static, K.allocator, K.refcount, K.output, K.heap];
const NON_RAW_MEM = MEM_CLASSES.reduce((m, c) => m | bit(c, WAR) | bit(c, WAW), 0);
const RAW_MEM = MEM_CLASSES.reduce((m, c) => m | bit(c, RAW), 0);
const ALL_BITS = CLASS_NAMES.reduce((m, _, c) => m | classBits(c), 0);
const SPWORD = 0x3fffffff;
const PAGE = 512;

class Grow32 {
	a = new Int32Array(1024);
	n = 0;
	push(v: number) {
		if (this.n === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.n++] = v;
	}
}
class GrowF64 {
	a = new Float64Array(1024);
	n = 0;
	push(v: number) {
		if (this.n === this.a.length) {
			const b = new Float64Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.n++] = v;
	}
}

export interface Layout {
	/** byte range of the Wasm shadow stack */
	stack: [number, number];
	/** byte range of static data */
	static: [number, number];
	/** log2 of the conflict granule in bytes, default 3 */
	grain?: number;
}

/** one segment of the trace; reads and writes are flat [lo, hi, cat] triples of granule indices */
export interface WNode {
	weight: number;
	/** structural predecessors, as ids returned by add */
	preds: number[];
	inv: number;
	reads: number[];
	writes: number[];
	/** bit 0 reads the stack pointer register, bit 1 writes it */
	sp?: number;
	host?: number;
	/** a join node, one per invocation exit */
	join?: boolean;
	label?: string;
	allocs?: number[];
	frees?: number[];
}

export interface Model {
	name: string;
	removed: number[];
	only?: boolean;
	spec?: boolean;
	rollback?: number;
}

const LADDER: Model[] = [
	{ name: 'M0_spawn_join', removed: [], only: true },
	{ name: 'M1_all_conflicts', removed: [] },
	{ name: 'M2_rename_sp', removed: [K.stack] },
	{ name: 'M3_rename_alloc', removed: [K.stack, K.allocator] },
	{ name: 'M4_refcount_delta', removed: [K.stack, K.allocator, K.refcount] },
	{ name: 'M5_output_ordered', removed: [K.stack, K.allocator, K.refcount, K.output] },
	{ name: 'M6_host_buffered', removed: [K.stack, K.allocator, K.refcount, K.output, K.host] },
	{
		name: 'M7_speculation',
		removed: [K.stack, K.allocator, K.refcount, K.output, K.host],
		spec: true
	}
];

const EXTENSIONS: Model[] = [
	{
		name: 'X1_privatize_static',
		removed: [K.stack, K.allocator, K.refcount, K.output, K.host, K.static],
		spec: true
	}
];

export interface AnalysisOptions {
	allocTracking?: boolean;
	/** how the host_buffered precondition is decided: assumed, or a list of names that cannot replay */
	hostReplay?: 'assumed' | 'violated';
	rollback?: number;
	/** end-of-trace span terms per unit, charged when the matching switch is on */
	merge?: { alloc?: number; refcount?: number; output?: number; host?: number };
	/** the number of sensitivity rows to skip when the graph is large */
	sensitivity?: boolean;
	/** related(a, b) for invocation ids a (earlier node) and b (current node) */
	related?: (a: number, b: number) => boolean;
}

export class WorkSpan {
	readonly layout: Layout;
	readonly shift: number;
	related: (a: number, b: number) => boolean;
	weight = new GrowF64();
	invOf = new Grow32();
	eStart = new Grow32();
	ePred = new Grow32();
	eMask = new Grow32();
	labels = new Map<number, string>();
	virtual = 0;
	realNodes = 0;
	events = { host: 0, intervalRecords: 0, nodes: 0, joins: 0, outputNodes: 0 };
	checks = { stackRawCross: 0, outOtherWrites: 0, crossFrees: 0, allocs: 0, frees: 0 };
	private pages = new Map<number, Page>();
	private lastPageKey = -1;
	private lastPage!: Page;
	private rdNode = new Grow32();
	private rdCat = new Grow32();
	private rdNext = new Grow32();
	private runNode = new Grow32();
	private runCat = new Grow32();
	private runNext = new Grow32();
	private lastHost = -1;
	private edges = new Map<number, number>();
	private allocOwner = new Map<number, number>();
	private stackRaw = new Set<number>();

	constructor(layout: Layout, related?: (a: number, b: number) => boolean) {
		this.layout = layout;
		this.shift = layout.grain ?? 3;
		this.related = related ?? ((a, b) => a === b);
		this.rdNode.push(-1);
		this.rdCat.push(0);
		this.rdNext.push(-1);
		this.runNode.push(-1);
		this.runCat.push(0);
		this.runNext.push(-1);
	}

	get nodeCount() {
		return this.weight.n;
	}

	private page(w: number) {
		const key = Math.floor(w / PAGE);
		if (key !== this.lastPageKey) {
			let p = this.pages.get(key);
			if (!p) {
				p = new Page();
				this.pages.set(key, p);
			}
			this.lastPageKey = key;
			this.lastPage = p;
		}
		return this.lastPage;
	}

	private regionClass(w: number) {
		if (w === SPWORD) return K.stack;
		const byte = w * 2 ** this.shift;
		const { stack, static: data } = this.layout;
		if (byte >= stack[0] && byte < stack[1]) return K.stack;
		if (byte >= data[0] && byte < data[1]) return K.static;
		return K.heap;
	}

	private classOf(w: number, a: number, b: number) {
		if (a === CAT.rc && b === CAT.rc) return K.refcount;
		if (a === CAT.out && b === CAT.out) return K.output;
		if (a === CAT.alloc || b === CAT.alloc) return K.allocator;
		return this.regionClass(w);
	}

	private edge(pred: number, cls: number, kind: number) {
		if (pred < 0) return;
		this.edges.set(pred, (this.edges.get(pred) ?? 0) | bit(cls, kind));
	}

	private commit(preds: Map<number, number> | number[], weight: number, inv: number) {
		const id = this.weight.n;
		this.eStart.push(this.ePred.n);
		if (Array.isArray(preds)) {
			for (const p of preds) {
				this.ePred.push(p);
				this.eMask.push(bit(K.spawn, RAW));
			}
		} else {
			for (const [p, m] of preds) {
				this.ePred.push(p);
				this.eMask.push(m);
			}
		}
		this.weight.push(weight);
		this.invOf.push(inv);
		return id;
	}

	private commitVirtual(
		sources: number[],
		cats: number[],
		w: number,
		consumerCat: number,
		kind: number
	) {
		const m = new Map<number, number>();
		for (let i = 0; i < sources.length; i++) {
			const cls = this.classOf(w, cats[i]!, consumerCat);
			m.set(sources[i]!, (m.get(sources[i]!) ?? 0) | bit(cls, kind));
		}
		this.virtual++;
		return this.commit(m, 0, -1);
	}

	private pushRd(node: number, cat: number, next: number) {
		this.rdNode.push(node);
		this.rdCat.push(cat);
		this.rdNext.push(next);
		return this.rdNode.n - 1;
	}

	private pushRun(node: number, cat: number, next: number) {
		this.runNode.push(node);
		this.runCat.push(cat);
		this.runNext.push(next);
		return this.runNode.n - 1;
	}

	/** compacts the commutative run of a granule into one node and returns [node, cat] or null */
	private foldRun(p: Page, o: number, w: number, consumerCat: number, kind: number) {
		const head = p.run[o]!;
		if (head <= 0) return null;
		if (this.runNext.a[head]! <= 0)
			return [this.runNode.a[head]!, this.runCat.a[head]!] as const;
		const nodes: number[] = [];
		const cats: number[] = [];
		for (let i = head; i > 0; i = this.runNext.a[i]!) {
			nodes.push(this.runNode.a[i]!);
			cats.push(this.runCat.a[i]!);
		}
		const cat = cats[0]!;
		const v = this.commitVirtual(nodes, cats, w, consumerCat, kind);
		p.run[o] = this.pushRun(v, cat, 0);
		return [v, cat] as const;
	}

	private foldReaders(p: Page, o: number, w: number, consumerCat: number) {
		const head = p.rd[o]!;
		if (head <= 0) return null;
		if (this.rdNext.a[head]! <= 0) return [this.rdNode.a[head]!, this.rdCat.a[head]!] as const;
		const nodes: number[] = [];
		const cats: number[] = [];
		for (let i = head; i > 0; i = this.rdNext.a[i]!) {
			nodes.push(this.rdNode.a[i]!);
			cats.push(this.rdCat.a[i]!);
		}
		const v = this.commitVirtual(nodes, cats, w, consumerCat, WAR);
		p.rd[o] = this.pushRd(v, CAT.plain, 0);
		return [v, CAT.plain] as const;
	}

	private readEdges(w: number, cat: number) {
		const p = this.page(w);
		const o = w % PAGE;
		const pw = p.w[o]!;
		if (pw >= 0) {
			const cls = this.classOf(w, p.wc[o]!, cat);
			this.edge(pw, cls, RAW);
			if (cls === K.stack && w !== SPWORD) this.stackRaw.add(pw);
		}
		const head = p.run[o]!;
		if (head > 0) {
			if (cat === CAT.rc || cat === CAT.out) {
				this.edge(this.runNode.a[head]!, this.classOf(w, this.runCat.a[head]!, cat), RAW);
			} else {
				const f = this.foldRun(p, o, w, cat, RAW);
				if (f) this.edge(f[0], this.classOf(w, f[1], cat), RAW);
			}
		}
	}

	private writeEdges(w: number, cat: number) {
		const p = this.page(w);
		const o = w % PAGE;
		const pw = p.w[o]!;
		if (pw >= 0) this.edge(pw, this.classOf(w, p.wc[o]!, cat), WAW);
		const head = p.run[o]!;
		if (head > 0) {
			if (cat === CAT.rc || cat === CAT.out) {
				this.edge(this.runNode.a[head]!, this.classOf(w, this.runCat.a[head]!, cat), WAW);
			} else {
				const f = this.foldRun(p, o, w, cat, WAW);
				if (f) this.edge(f[0], this.classOf(w, f[1], cat), WAW);
			}
		}
		const rd = this.foldReaders(p, o, w, cat);
		if (rd) this.edge(rd[0], this.classOf(w, rd[1], cat), WAR);
	}

	private applyRead(w: number, cat: number, id: number) {
		const p = this.page(w);
		const o = w % PAGE;
		const head = p.rd[o]!;
		if (head > 0 && this.rdNode.a[head] === id) return;
		p.rd[o] = this.pushRd(id, cat, head > 0 ? head : 0);
	}

	private applyWrite(w: number, cat: number, id: number) {
		const p = this.page(w);
		const o = w % PAGE;
		if (cat === CAT.rc || cat === CAT.out) {
			const head = p.run[o]!;
			p.run[o] = this.pushRun(id, cat, head > 0 ? head : 0);
			return;
		}
		p.w[o] = id;
		p.wc[o] = cat;
		p.rd[o] = 0;
		p.run[o] = 0;
	}

	private scan(list: number[], fn: (w: number, cat: number) => void) {
		for (let i = 0; i < list.length; i += 3) {
			const lo = list[i]!;
			const hi = list[i + 1]!;
			const cat = list[i + 2]!;
			for (let w = lo; w <= hi; w++) fn(w, cat);
		}
	}

	add(node: WNode): number {
		this.edges = new Map<number, number>();
		for (const p of node.preds) this.edge(p, K.spawn, RAW);
		const sp = node.sp ?? 0;
		const stackWrites = node.writes;
		this.stackRaw.clear();
		if (sp & 1) this.readEdges(SPWORD, CAT.plain);
		if (sp & 2) this.writeEdges(SPWORD, CAT.plain);
		this.events.intervalRecords += (node.reads.length + node.writes.length) / 3;
		this.scan(node.reads, (w, cat) => this.readEdges(w, cat));
		this.scan(stackWrites, (w, cat) => {
			this.writeEdges(w, cat);
			if (cat === CAT.outOther) this.checks.outOtherWrites++;
		});
		if (node.join) this.events.joins++;
		if (node.writes.some((c, i) => i % 3 === 2 && (c === CAT.out || c === CAT.outOther)))
			this.events.outputNodes++;
		if (node.host) {
			this.events.host += node.host;
			if (this.lastHost >= 0) this.edge(this.lastHost, K.host, RAW);
		}
		const pre = this.edges;
		const id = this.weight.n;
		const nodeId = this.commit(pre, node.weight, node.inv);
		assert.equal(nodeId, id);
		if (node.label) this.labels.set(id, node.label);
		if (node.host) this.lastHost = id;
		this.realNodes++;
		if (sp & 1) this.applyRead(SPWORD, CAT.plain, id);
		this.scan(node.reads, (w, cat) => this.applyRead(w, cat, id));
		if (sp & 2) this.applyWrite(SPWORD, CAT.plain, id);
		this.scan(node.writes, (w, cat) => this.applyWrite(w, cat, id));
		this.checkStack(node.inv);
		for (let i = 0; node.allocs && i < node.allocs.length; i += 2) {
			this.checks.allocs++;
			this.allocOwner.set(node.allocs[i]!, node.inv);
		}
		for (const ptr of node.frees ?? []) {
			this.checks.frees++;
			const owner = this.allocOwner.get(ptr);
			if (owner !== undefined && !this.related(owner, node.inv)) this.checks.crossFrees++;
			this.allocOwner.delete(ptr);
		}
		this.events.nodes++;
		return id;
	}

	private checkStack(inv: number) {
		for (const p of this.stackRaw) {
			const pinv = this.invOf.a[p]!;
			if (pinv >= 0 && !this.related(pinv, inv)) this.checks.stackRawCross++;
		}
	}

	conflictCounts() {
		const by: Record<string, number> = {};
		const kinds = [0, 0, 0];
		for (let i = 0; i < this.eMask.n; i++) {
			const m = this.eMask.a[i]!;
			for (let c = 1; c < 8; c++)
				for (let k = 0; k < 3; k++)
					if (m & bit(c, k)) {
						kinds[k]!++;
						by[CLASS_NAMES[c]!] = (by[CLASS_NAMES[c]!] ?? 0) + 1;
					}
		}
		return { raw: kinds[0]!, war: kinds[1]!, waw: kinds[2]!, by_class: by };
	}

	private keepBits(model: Model) {
		if (model.only) return classBits(K.spawn);
		let keep = ALL_BITS;
		for (const c of model.removed) keep &= ~classBits(c);
		if (model.spec) keep &= ~NON_RAW_MEM;
		return keep;
	}

	evaluate(model: Model, rollbackDefault = 0, merge: AnalysisOptions['merge'] = {}) {
		const n = this.weight.n;
		const keep = this.keepBits(model);
		const spec = model.spec === true;
		const rollback = model.rollback ?? rollbackDefault;
		const F = new Float64Array(n);
		const argp = new Int32Array(n).fill(-1);
		const argm = new Int32Array(n);
		const replayed = new Uint8Array(spec ? n : 0);
		let work = 0;
		let replays = 0;
		let best = -1;
		let bestId = -1;
		const w = this.weight.a;
		const es = this.eStart.a;
		const ep = this.ePred.a;
		const em = this.eMask.a;
		const total = this.ePred.n;
		for (let i = 0; i < n; i++) {
			let S = 0;
			let R = 0;
			let sp = -1;
			let rp = -1;
			let sm = 0;
			let rm = 0;
			const end = i + 1 < n ? es[i + 1]! : total;
			for (let e = es[i]!; e < end; e++) {
				const m = em[e]! & keep;
				if (!m) continue;
				const p = ep[e]!;
				const fp = F[p]!;
				if (spec && (m & RAW_MEM) !== 0 && (m & ~RAW_MEM) === 0) {
					if (fp > R) {
						R = fp;
						rp = p;
						rm = m;
					}
				} else if (fp > S) {
					S = fp;
					sp = p;
					sm = m;
				}
			}
			const wi = w[i]!;
			work += wi;
			if (spec && R > S) {
				const specEnd = S + wi;
				if (wi > 0) {
					replays++;
					replayed[i] = 1;
				}
				if (R >= specEnd) {
					F[i] = R + wi + (wi > 0 ? rollback : 0);
					argp[i] = rp;
					argm[i] = rm;
				} else {
					F[i] = specEnd + wi + (wi > 0 ? rollback : 0);
					argp[i] = sp;
					argm[i] = sm;
				}
			} else {
				F[i] = S + wi;
				argp[i] = sp;
				argm[i] = sm;
			}
			if (F[i]! > best) {
				best = F[i]!;
				bestId = i;
			}
		}
		const has = (c: number) => model.removed.includes(c) && !model.only;
		const extra =
			(has(K.allocator) ? (merge.alloc ?? 0) * this.events.joins : 0) +
			(has(K.refcount) ? (merge.refcount ?? 0) * this.events.joins : 0) +
			(has(K.output) ? (merge.output ?? 0) * this.events.outputNodes : 0) +
			(has(K.host) ? (merge.host ?? 0) * this.events.host : 0);
		const span = best < 0 ? 0 : best + extra;
		const totals = new Float64Array(8);
		const path: { id: number; weight: number }[] = [];
		for (let i = bestId; i >= 0; i = argp[i]!) {
			const credit = w[i]! * (replayed[i] ? 2 : 1);
			path.push({ id: i, weight: w[i]! });
			if (argp[i]! < 0) break;
			for (let c = 0; c < 8; c++) if (argm[i]! & classBits(c)) totals[c]! += credit;
		}
		path.reverse();
		const peak = Math.max(0, ...totals);
		const binding = peak > 0 ? CLASS_NAMES.filter((_, c) => totals[c] === peak) : [];
		return {
			work,
			span,
			parallelism: span > 0 ? work / span : null,
			binding_class: binding,
			serializing_classes: CLASS_NAMES.map((name, c) => ({
				class: name,
				span_weight: totals[c]!
			})).filter((r) => r.span_weight > 0),
			replays,
			path_nodes: path.length,
			top_span_path: [...path]
				.sort((a, b) => b.weight - a.weight || a.id - b.id)
				.slice(0, 10)
				.map((r) => ({ name: this.labels.get(r.id) ?? `node ${r.id}`, weight: r.weight }))
		};
	}

	/** the ladder, with validity decided by the recorded checks */
	ladder(options: AnalysisOptions = {}) {
		return this.rungs(LADDER, options);
	}

	/** hypothetical rungs past M7, labelled as extensions: no switch of the ladder implements them */
	extensions(options: AnalysisOptions = {}) {
		return this.rungs([...LADDER, ...EXTENSIONS], options)
			.slice(LADDER.length)
			.map((row) => ({ ...row, extension: true }));
	}

	private rungs(models: Model[], options: AnalysisOptions) {
		const rows: any[] = [];
		let invalid: string[] = [];
		for (const model of models) {
			const reasons: string[] = [];
			const has = (c: number) => model.removed.includes(c);
			if (has(K.stack) && this.checks.stackRawCross > 0)
				reasons.push(
					`rename_sp: ${this.checks.stackRawCross} stack RAW edges join unrelated invocations`
				);
			if (has(K.allocator) && options.allocTracking && this.checks.crossFrees > 0)
				reasons.push(`rename_alloc: ${this.checks.crossFrees} frees cross invocations`);
			if (has(K.output) && this.checks.outOtherWrites > 0)
				reasons.push(
					`output_ordered: ${this.checks.outOtherWrites} non-append output writes`
				);
			if (has(K.host) && options.hostReplay === 'violated')
				reasons.push('host_buffered: a host call cannot be replayed in order');
			invalid = [...invalid, ...reasons.filter((r) => !invalid.includes(r))];
			const valid = invalid.length === 0;
			const preconditions: Record<string, string> = {};
			if (has(K.stack)) preconditions.rename_sp = 'checked';
			if (has(K.allocator))
				preconditions.rename_alloc = options.allocTracking ? 'checked' : 'unchecked';
			if (has(K.refcount)) preconditions.refcount_delta = 'tags verified by counter';
			if (has(K.output)) preconditions.output_ordered = 'checked';
			if (has(K.host)) preconditions.host_buffered = options.hostReplay ?? 'assumed';
			const computed = this.evaluate(model, options.rollback ?? 0, options.merge);
			const result = valid ? computed : null;
			rows.push({
				name: model.name,
				switches: {
					rename_sp: has(K.stack),
					rename_alloc: has(K.allocator),
					refcount_delta: has(K.refcount),
					output_ordered: has(K.output),
					host_buffered: has(K.host),
					speculation: { enabled: model.spec === true, conflict_source: 'trace' }
				},
				preconditions,
				valid,
				invalid_reasons: [...invalid],
				...(valid
					? {}
					: {
							unchecked: {
								note: 'computed with the failed precondition ignored; not a valid model',
								work: computed.work,
								span: computed.span,
								parallelism: computed.parallelism,
								binding_class: computed.binding_class,
								replays: computed.replays
							}
						}),
				...(result ?? {
					work: null,
					span: null,
					parallelism: null,
					binding_class: [],
					serializing_classes: [],
					replays: null,
					top_span_path: []
				})
			});
		}
		return rows;
	}

	/** M1 with one class removed, and M1 with every class but one removed; preconditions unchecked */
	sensitivity() {
		const out: Record<string, { only_removed: number | null; all_but: number | null }> = {};
		for (const c of MEM_CLASSES.concat([K.host])) {
			const alone = this.evaluate({ name: 'x', removed: [c] });
			const others = [...MEM_CLASSES, K.host].filter((x) => x !== c);
			const rest = this.evaluate({ name: 'y', removed: others });
			out[CLASS_NAMES[c]!] = { only_removed: alone.parallelism, all_but: rest.parallelism };
		}
		return out;
	}
}

class Page {
	w = new Int32Array(PAGE).fill(-1);
	wc = new Uint8Array(PAGE);
	rd = new Int32Array(PAGE);
	run = new Int32Array(PAGE);
}

/** merges byte intervals into sorted granule triples per category */
export function toGranules(items: { lo: number; hi: number; cat: number }[], shift = 3) {
	const byCat = new Map<number, [number, number][]>();
	for (const i of items) {
		if (i.hi <= i.lo) continue;
		const list = byCat.get(i.cat) ?? [];
		list.push([Math.floor(i.lo / 2 ** shift), Math.floor((i.hi - 1) / 2 ** shift)]);
		byCat.set(i.cat, list);
	}
	const out: number[] = [];
	for (const [cat, list] of [...byCat].sort((a, b) => a[0] - b[0])) {
		list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		let [lo, hi] = list[0]!;
		for (const [l, h] of list.slice(1)) {
			if (l <= hi + 1) hi = Math.max(hi, h);
			else {
				out.push(lo, hi, cat);
				[lo, hi] = [l, h];
			}
		}
		out.push(lo, hi, cat);
	}
	return out;
}

export function record(
	ws: WorkSpan,
	meta: {
		module: { name: string; sha256: string };
		input: { id: string; sha256?: string };
		machine: { name: string; node: string };
		granularity: string;
		events: Record<string, number>;
		assumptions: string[];
		unmeasured: string[];
	},
	options: AnalysisOptions = {}
) {
	return {
		schema: 'folio.worksp.v2',
		module: meta.module,
		input: meta.input,
		machine: meta.machine,
		granularity: meta.granularity,
		unit: 'wasm IR nodes executed',
		conflict_granule_bytes: 2 ** ws.shift,
		events: { ...meta.events, interval_records: ws.events.intervalRecords },
		nodes: { total: ws.nodeCount, real: ws.realNodes, virtual: ws.virtual },
		conflicts: ws.conflictCounts(),
		checks: ws.checks,
		models: [...ws.ladder(options), ...ws.extensions(options)],
		sensitivity: options.sensitivity === false ? undefined : ws.sensitivity(),
		measured: true,
		assumptions: meta.assumptions,
		unmeasured: meta.unmeasured
	};
}

export function summarizeWorksp(rows: any[], hash: string) {
	const samples = rows.filter((r) => r.kind === 'sample');
	assert.ok(samples.length > 0, 'no worksp samples');
	const inputs: Record<string, unknown> = {};
	for (const r of samples) {
		const key = `${r.name}#${r.repeat}`;
		const base = {
			mode: r.mode,
			outputEqual: r.outputEqual,
			nativeMs: r.nativeMs,
			instrumentedMs: r.instrumentedWallMs,
			slowdown: Number(r.slowdown.toFixed(2)),
			counters: r.counters,
			invocations: r.stats?.invocations ?? r.counts?.invocations
		};
		if (!r.record) {
			inputs[key] = { ...base, dispatches: r.counts.dispatches, host: r.counts.hostWrapped };
			continue;
		}
		const rec = r.record;
		assert.equal(rec.schema, 'folio.worksp.v2');
		inputs[key] = {
			...base,
			granularity: rec.granularity,
			work: rec.models[1]?.work,
			nodes: rec.nodes,
			intervalRecords: rec.events.interval_records,
			checks: rec.checks,
			ladder: rec.models.map((m: any) => ({
				name: m.name,
				extension: m.extension === true,
				valid: m.valid,
				parallelism: m.parallelism === null ? null : Number(m.parallelism.toFixed(3)),
				uncheckedParallelism:
					m.unchecked?.parallelism == null
						? undefined
						: Number(m.unchecked.parallelism.toFixed(3)),
				binding: m.valid ? m.binding_class : m.unchecked?.binding_class,
				replays: m.replays ?? m.unchecked?.replays
			})),
			sensitivity: rec.sensitivity
		};
	}
	return { inputs, rawSha256: hash };
}

export function analyzeWorksp(set: string, file: string) {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizeWorksp(parseRows(raw), sha256(raw));
	writeFileSync(
		new URL(file.replace(/\.jsonl$/, '.summary.json'), root),
		JSON.stringify(summary, null, 2) + '\n'
	);
}
