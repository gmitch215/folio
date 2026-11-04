import binaryen from 'binaryen';
import { buildModule, mulberry, sha256 } from '../lib.ts';
import { buildC, buildWat, writeSpecs, type Spec } from './lib.ts';
import { cSpecs } from './specs-c.ts';
import { wSpecs } from './specs-w.ts';

// usage: gen-m.ts [PER_BASE]; mutates 30 base modules one site at a time and keeps the valid
// distinct ones as specs/mutants.json under the output directory (40 per base gives 1199)

type Node = string | Node[];

function parse(text: string): Node {
	const tokens = text.replace(/;;.*$/gm, '').match(/\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+/g)!;
	let k = 0;
	const read = (): Node => {
		const t = tokens[k++]!;
		if (t !== '(') return t;
		const list: Node[] = [];
		while (tokens[k] !== ')') list.push(read());
		k++;
		return list;
	};
	return read();
}
const print = (n: Node): string => (typeof n === 'string' ? n : `(${n.map(print).join(' ')})`);

const SWAP: Record<string, string[]> = {
	'i32.add': ['i32.sub', 'i32.xor'],
	'i32.sub': ['i32.add'],
	'i32.mul': ['i32.add', 'i32.shl'],
	'i32.xor': ['i32.or', 'i32.add', 'i32.and'],
	'i32.or': ['i32.xor', 'i32.add'],
	'i32.and': ['i32.or', 'i32.xor'],
	'i32.shl': ['i32.shr_u', 'i32.rotl'],
	'i32.shr_u': ['i32.shl', 'i32.shr_s'],
	'i32.shr_s': ['i32.shr_u'],
	'i32.rem_u': ['i32.div_u', 'i32.rem_s'],
	'i32.div_u': ['i32.rem_u'],
	'i32.rotl': ['i32.rotr', 'i32.shl'],
	'i32.rotr': ['i32.rotl'],
	'i32.lt_u': ['i32.le_u', 'i32.gt_u'],
	'i32.le_u': ['i32.lt_u'],
	'i32.ge_u': ['i32.gt_u', 'i32.lt_u'],
	'i32.gt_u': ['i32.ge_u'],
	'i32.eq': ['i32.ne'],
	'i32.ne': ['i32.eq'],
	'i32.load8_u': ['i32.load8_s', 'i32.load16_u'],
	'i32.store8': ['i32.store16'],
	'i64.add': ['i64.sub', 'i64.xor'],
	'i64.mul': ['i64.add'],
	'i64.shl': ['i64.shr_u'],
	'i64.shr_u': ['i64.shl'],
	'i64.rem_u': ['i64.div_u'],
	'i64.xor': ['i64.or']
};
const BIN = /^i(32|64)\.(add|sub|mul|xor|or|and|shl|shr_u|shr_s|rem_u|div_u|rotl|rotr)$/;

interface Site {
	kind: string;
	apply: () => void;
	undo: () => void;
}

function sites(root: Node): Site[] {
	const out: Site[] = [];
	const walk = (n: Node, inFunc: boolean) => {
		if (typeof n === 'string') return;
		const head = n[0];
		const fn = inFunc || head === 'func';
		if (fn && typeof head === 'string') {
			const rep = (name: string, to: Node[]) => {
				const saved = [...n];
				out.push({
					kind: name,
					apply: () => n.splice(0, n.length, ...to),
					undo: () => n.splice(0, n.length, ...saved)
				});
			};
			if ((head === 'i32.const' || head === 'i64.const') && typeof n[1] === 'string') {
				const v = BigInt(n[1]);
				const w = head === 'i32.const' ? 32n : 64n;
				const norm = (x: bigint) => BigInt.asIntN(Number(w), x).toString();
				for (const [tag, x] of [
					['c+1', v + 1n],
					['c-1', v - 1n],
					['c^1', v ^ 1n],
					['c0', 0n],
					['c1', 1n],
					['c*2', v * 2n]
				] as const)
					if (norm(x) !== n[1]) rep(tag, [head, norm(x)]);
			}
			if (SWAP[head])
				for (const to of SWAP[head]!) rep(`swap:${head}>${to}`, [to, ...n.slice(1)]);
			if (BIN.test(head) && n.length === 3) {
				rep(`left:${head}`, n[1] as Node[]);
				rep(`right:${head}`, n[2] as Node[]);
			}
			if (/^i(32|64)\.(load|store)/.test(head)) {
				const k = n.findIndex(
					(x, i) => i > 0 && typeof x === 'string' && x.startsWith('offset=')
				);
				if (k < 0) rep('offset+1', [head, 'offset=1', ...n.slice(1)]);
				else {
					const cur = Number((n[k] as string).slice(7));
					rep('offset-drop', [head, ...n.slice(1, k), ...n.slice(k + 1)]);
					rep('offset+1', [
						head,
						...n.slice(1, k),
						`offset=${cur + 1}`,
						...n.slice(k + 1)
					]);
				}
			}
		}
		for (const child of n) walk(child, fn);
	};
	walk(root, false);
	return out;
}

const toText = (bytes: Uint8Array): string => {
	const m = binaryen.readBinary(bytes);
	try {
		m.setFeatures(binaryen.Features.All);
		return m.emitText();
	} finally {
		m.dispose();
	}
};
const watOf = (id: string) => toText(buildWat(wSpecs.find((x) => x.id === id)!.src));
const cOf = (id: string) => {
	const s = cSpecs.find((x) => x.id === id)!;
	return toText(buildC(s.src, s.opt!));
};
const baseIds: [string, () => string][] = [
	['wat-adler', () => watOf('rw-adler/ok-head')],
	['wat-adler-two', () => watOf('rw-adler/ok-two')],
	['wat-adler-tail', () => watOf('rw-adler/ok-tail')],
	['wat-xlcg', () => watOf('ow-loop/xlcg-head')],
	['wat-xs', () => watOf('ow-loop/xs-head')],
	['wat-feed-ct', () => watOf('ow-loop/feed-ct-head')],
	['wat-stride2', () => watOf('ow-stride2/ok-head')],
	['wat-sbox', () => watOf('ow-loop/sbox-head')],
	['c-adler-O1', () => cOf('rc-byte/P65521-O1')],
	['c-adler-O2', () => cOf('rc-byte/P65521-O2')],
	['c-adler-O3', () => cOf('rc-byte/P65521-O3')],
	['c-adler-Os', () => cOf('rc-byte/P65521-Os')],
	['c-block4-O2', () => cOf('rc-block/P65521-k4-O2')],
	['c-block16-O3', () => cOf('rc-block/P65521-k16-O3')],
	['c-block1-O2', () => cOf('rc-block/P65521-k1-O2')],
	['c-fullmod-O2', () => cOf('rc-byte/fullmod-P65521-O2')],
	['c-coef-O2', () => cOf('rc-coef/P65521-31-1-0-1-1-O2')],
	['c-counter-O2', () => cOf('rc-counter/and-O2')],
	['c-xlcg-O2', () => cOf('oc-loop/lcg-xor-O2')],
	['c-xlcg-O3', () => cOf('oc-loop/lcg-xor-O3')],
	['c-xs-O2', () => cOf('oc-loop/xs-xor-O2')],
	['c-sbox-O2', () => cOf('oc-loop/ctr-sbox-O2')],
	['c-sbox16-O2', () => cOf('oc-loop/ctr-sbox16-O2')],
	['c-feed-O2', () => cOf('oc-loop/feed-add-O2')],
	['c-cbc-O2', () => cOf('oc-loop/cbc-ct-O2')],
	['c-unroll4-O2', () => cOf('oc-struct/unroll4-ok-O2')],
	['c-zpout-O2', () => cOf('oc-zp/ctr-O2')],
	['c-zpout-feed-O2', () => cOf('oc-zp/feed-old-O2')],
	['c-zpout-set-O2', () => cOf('oc-zp/set-O2')],
	['c-unroll-adler-O2', () => cOf('rc-unroll/U4-none-0-O2')]
];

const PER_BASE = Number(process.argv[2] ?? 40);
const r = mulberry(2024);
const seen = new Set<string>();
const mutants: Spec[] = [];
const stats: Record<string, number> = {};
for (const [name, get] of baseIds) {
	const tree = parse(get());
	const list = sites(tree);
	const order = list.map((_, i) => i).sort(() => r() - 0.5);
	let kept = 0;
	// keep a spread of mutation kinds
	const perKind = new Map<string, number>();
	for (const i of order) {
		if (kept >= PER_BASE) break;
		const s = list[i]!;
		const kind = s.kind.split(':')[0]!.replace(/[+-]?\d+/g, '');
		if ((perKind.get(kind) ?? 0) >= Math.ceil(PER_BASE / 4)) continue;
		s.apply();
		const mod = print(tree);
		s.undo();
		let bytes: Uint8Array;
		try {
			bytes = buildModule(mod);
		} catch {
			continue;
		}
		const h = sha256(bytes);
		if (seen.has(h)) continue;
		seen.add(h);
		perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
		mutants.push({
			id: `mu-${name}/${kept}-${s.kind}`,
			family: `mu-${name.split('-')[0]}`,
			kind: 'watmod',
			src: mod,
			note: `${name} ${s.kind}`
		});
		stats[name] = (stats[name] ?? 0) + 1;
		kept++;
	}
}
writeSpecs('mutants.json', mutants);
console.log(mutants.length, JSON.stringify(stats));
