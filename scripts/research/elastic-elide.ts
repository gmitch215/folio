import { binaryen, children } from './elastic-walk.ts';

// a group is accesses off one pointer expression (a local plus a constant) with no call, write to
// the local, loop edge or (when sound) other checked access between them; one lookup at the leader
// stands for all of them when the span of their offsets stays inside one page
const SPAN = 256;

export interface ElideSite {
	expr: number;
	store: boolean;
	shape: 'local' | 'localconst' | 'other';
	base: number;
	/** the constant added to the base local in the pointer expression */
	add: number;
	/** the load or store offset immediate */
	offset: number;
	bytes: number;
	ptr: string;
	/** `leader` pays the lookup, `member` could reuse it; sound closes the group at any other checked access */
	sound: 'leader' | 'member' | 'none';
	region: 'leader' | 'member' | 'none';
	oracle: 'leader' | 'member' | 'none';
	/** sound members point at their leader; a sound leader carries the offset span of its group */
	lead?: ElideSite;
	lo?: number;
	hi?: number;
	/** relation of the base to the innermost enclosing loop */
	loop: 'none' | 'invariant' | 'affine' | 'varies';
	loopCalls: boolean;
	loopInner: boolean;
}

interface Group {
	base: number;
	leader: ElideSite;
	lo: number;
	hi: number;
}
type State = Map<string, Group> | null;
interface Frame {
	writes: Map<number, 'affine' | 'other'>;
	calls: boolean;
	inner: boolean;
}

const constOf = (e: number) =>
	binaryen.getExpressionId(e) === binaryen.ConstId &&
	binaryen.getExpressionType(e) === binaryen.i32
		? (binaryen.Const.getValueI32(e) as number)
		: undefined;

const idNames = new Map<number, string>(
	Object.entries(binaryen)
		.filter(([k, v]) => /Id$/.test(k) && typeof v === 'number')
		.map(([k, v]) => [v as number, k.replace(/Id$/, '').toLowerCase()])
);

const opNames = new Map<number, string>([
	[binaryen.AddInt32, 'add'],
	[binaryen.SubInt32, 'sub'],
	[binaryen.ShlInt32, 'shl'],
	[binaryen.MulInt32, 'mul'],
	[binaryen.AndInt32, 'and']
]);

// the pointer expression as a short tree, to see which shapes the grouping does not cover
function ptrKey(e: number, depth = 3): string {
	const id = binaryen.getExpressionId(e);
	if (id === binaryen.ConstId) return 'c';
	if (id === binaryen.LocalGetId) return 'l';
	if (depth === 0) return idNames.get(id) ?? String(id);
	if (id === binaryen.BinaryId) {
		const op: number = binaryen.Binary.getOp(e);
		const left = ptrKey(binaryen.Binary.getLeft(e), depth - 1);
		const right = ptrKey(binaryen.Binary.getRight(e), depth - 1);
		return `${opNames.get(op) ?? `op${op}`}(${left},${right})`;
	}
	if (id === binaryen.LoadId) return `load(${ptrKey(binaryen.Load.getPtr(e), depth - 1)})`;
	if (id === binaryen.LocalSetId)
		return `tee(${ptrKey(binaryen.LocalSet.getValue(e), depth - 1)})`;
	return idNames.get(id) ?? String(id);
}

function shapeOf(ptr: number): { shape: ElideSite['shape']; base: number; add: number } {
	const id = binaryen.getExpressionId(ptr);
	if (id === binaryen.LocalGetId)
		return { shape: 'local', base: binaryen.LocalGet.getIndex(ptr), add: 0 };
	if (id === binaryen.BinaryId && binaryen.Binary.getOp(ptr) === binaryen.AddInt32) {
		const left = binaryen.Binary.getLeft(ptr);
		const c = constOf(binaryen.Binary.getRight(ptr));
		if (binaryen.getExpressionId(left) === binaryen.LocalGetId && c !== undefined)
			return { shape: 'localconst', base: binaryen.LocalGet.getIndex(left), add: c };
	}
	return { shape: 'other', base: -1, add: 0 };
}

// local.set x (local.get x + c) is a step of a pointer walk
function affineStep(set: number): boolean {
	const index = binaryen.LocalSet.getIndex(set);
	const value = binaryen.LocalSet.getValue(set);
	if (binaryen.getExpressionId(value) !== binaryen.BinaryId) return false;
	const op = binaryen.Binary.getOp(value);
	if (op !== binaryen.AddInt32 && op !== binaryen.SubInt32) return false;
	const left = binaryen.Binary.getLeft(value);
	return (
		binaryen.getExpressionId(left) === binaryen.LocalGetId &&
		binaryen.LocalGet.getIndex(left) === index &&
		constOf(binaryen.Binary.getRight(value)) !== undefined
	);
}

function meet(a: State, b: State): State {
	if (a === null) return b;
	if (b === null) return a;
	const out = new Map<string, Group>();
	for (const [k, g] of a) if (b.get(k) === g) out.set(k, g);
	return out;
}

type Mode = 'sound' | 'region' | 'oracle';

/**
 * Walks one function body in evaluation order and labels every access for which `checked` is true,
 * once per mode. `sound` closes the open groups at every other checked access, because that lookup
 * may run the pager and evict a page a group relied on. `region` closes them only at a checked
 * access whose pointer is not a local, which a region lookup done up front with no handler call
 * (falling back to the unelided code when any page is missing) would allow. `oracle` never closes
 * on an access, which no scheme can do, so its member share bounds the other two from above.
 * Calls, memory.grow, a write to the base local and every loop entry and exit close every group in
 * every mode.
 */
export function analyzeElision(
	body: number,
	checked: (e: number, ptr: number, offset: number, bytes: number) => boolean,
	unknown: Set<string>
): ElideSite[] {
	const sites: ElideSite[] = [];
	const labels = new Map<number, ElideSite>();
	for (const mode of ['sound', 'region', 'oracle'] as const) run(mode);
	return sites;

	function run(mode: Mode) {
		const frames: Frame[] = [];
		const owner = new Map<ElideSite, Frame | undefined>();
		const pending = new Map<string, State>();
		const groups: Group[] = [];
		const copy = (s: State): State => (s === null ? null : new Map(s));
		const branch = (name: string, st: State) => {
			const prior = pending.get(name);
			pending.set(name, prior === undefined ? copy(st) : meet(prior, st));
		};
		const kill = (s: State, local: number): State => {
			if (s === null) return s;
			const out = new Map(s);
			for (const [k, g] of s) if (g.base === local) out.delete(k);
			return out;
		};
		const place = (s: Map<string, Group>, site: ElideSite): Map<string, Group> => {
			const key = `${site.base}:${site.add}`;
			const g = s.get(key);
			const lo = g ? Math.min(g.lo, site.offset) : site.offset;
			const hi = g ? Math.max(g.hi, site.offset + site.bytes) : site.offset + site.bytes;
			if (g && hi - lo <= SPAN) {
				g.lo = lo;
				g.hi = hi;
				site[mode] = 'member';
				if (mode === 'sound') site.lead = g.leader;
				return s;
			}
			// a leader's own lookup may evict the pages other groups were verified on
			const out = mode === 'sound' ? new Map<string, Group>() : new Map(s);
			const created = {
				base: site.base,
				leader: site,
				lo: site.offset,
				hi: site.offset + site.bytes
			};
			groups.push(created);
			out.set(key, created);
			site[mode] = 'leader';
			return out;
		};

		function walk(e: number, st: State): State {
			const id = binaryen.getExpressionId(e);
			switch (id) {
				case binaryen.BlockId: {
					const name: string = binaryen.Block.getName(e);
					if (name) pending.delete(name);
					for (let k = 0, n = binaryen.Block.getNumChildren(e); k < n; k++)
						st = walk(binaryen.Block.getChildAt(e, k), st);
					if (name && pending.has(name)) st = meet(st, pending.get(name)!);
					return st;
				}
				case binaryen.IfId: {
					st = walk(binaryen.If.getCondition(e), st);
					const t = walk(binaryen.If.getIfTrue(e), copy(st));
					const f = binaryen.If.getIfFalse(e)
						? walk(binaryen.If.getIfFalse(e), copy(st))
						: st;
					return meet(t, f);
				}
				case binaryen.LoopId: {
					for (const f of frames) f.inner = true;
					frames.push({ writes: new Map(), calls: false, inner: false });
					const r = walk(binaryen.Loop.getBody(e), new Map());
					frames.pop();
					return r === null ? null : new Map();
				}
				case binaryen.BreakId: {
					if (binaryen.Break.getValue(e)) st = walk(binaryen.Break.getValue(e), st);
					if (binaryen.Break.getCondition(e))
						st = walk(binaryen.Break.getCondition(e), st);
					branch(binaryen.Break.getName(e), st);
					return binaryen.Break.getCondition(e) ? st : null;
				}
				case binaryen.SwitchId: {
					if (binaryen.Switch.getValue(e)) st = walk(binaryen.Switch.getValue(e), st);
					st = walk(binaryen.Switch.getCondition(e), st);
					for (let k = 0, n = binaryen.Switch.getNumNames(e); k < n; k++)
						branch(binaryen.Switch.getNameAt(e, k), st);
					branch(binaryen.Switch.getDefaultName(e), st);
					return null;
				}
				case binaryen.ReturnId:
				case binaryen.UnreachableId: {
					if (id === binaryen.ReturnId && binaryen.Return.getValue(e))
						walk(binaryen.Return.getValue(e), st);
					return null;
				}
				case binaryen.CallId:
				case binaryen.CallIndirectId:
				case binaryen.MemoryGrowId: {
					// every operand runs before the call, so a group opened in one is closed by it
					children(e, id, (c) => void (st = walk(c, st)), unknown);
					for (const f of frames) f.calls = true;
					return st === null ? null : new Map();
				}
				case binaryen.LocalSetId: {
					st = walk(binaryen.LocalSet.getValue(e), st);
					const local: number = binaryen.LocalSet.getIndex(e);
					const step = affineStep(e);
					for (const f of frames)
						f.writes.set(
							local,
							step && f.writes.get(local) !== 'other' ? 'affine' : 'other'
						);
					return kill(st, local);
				}
				case binaryen.LoadId:
				case binaryen.StoreId: {
					const store = id === binaryen.StoreId;
					const ns = store ? binaryen.Store : binaryen.Load;
					const ptr: number = ns.getPtr(e);
					st = walk(ptr, st);
					if (store) st = walk(binaryen.Store.getValue(e), st);
					const offset: number = ns.getOffset(e);
					const bytes: number = ns.getBytes(e);
					if (
						binaryen.getExpressionType(ptr) === binaryen.unreachable ||
						!checked(e, ptr, offset, bytes)
					)
						return st;
					let site = labels.get(e);
					if (!site) {
						const { shape, base, add } = shapeOf(ptr);
						site = {
							expr: e,
							store,
							shape,
							base,
							add,
							offset,
							bytes,
							ptr: ptrKey(ptr),
							sound: 'none',
							region: 'none',
							oracle: 'none',
							loop: 'none',
							loopCalls: false,
							loopInner: false
						};
						labels.set(e, site);
						sites.push(site);
					}
					owner.set(site, frames.at(-1));
					// a pointer that is not a local runs a lookup the group cannot account for
					if (site.shape === 'other')
						return mode === 'oracle' || st === null ? st : new Map();
					return st === null ? st : place(st, site);
				}
				default:
					children(e, id, (c) => void (st = walk(c, st)), unknown);
					return st;
			}
		}

		walk(body, new Map());
		if (mode !== 'sound') return;
		for (const g of groups) {
			g.leader.lo = g.lo;
			g.leader.hi = g.hi;
		}
		for (const s of sites) {
			const f = owner.get(s);
			if (!f || s.shape === 'other') continue;
			s.loopCalls = f.calls;
			s.loopInner = f.inner;
			const w = f.writes.get(s.base);
			s.loop = w === undefined ? 'invariant' : w === 'affine' ? 'affine' : 'varies';
		}
	}
}
