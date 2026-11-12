import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Manifest, mulberry, toText, wat } from './gen-lib.ts';

// family bm-text: one-site mutations of the REAL subject binaries (read back through binaryen text),
//   with kinds round 3 did not use: operand order, load and store width and sign, memory offsets,
//   dropped and duplicated statements, inverted conditions, local swaps, signed relations,
//   extend sign, branch depth, if arms.
// family bm-byte: one-byte edits of the code section of the same binaries that still validate.
// usage: gen-bmut.ts PER_BASE_TEXT PER_BASE_BYTE

const dir = 'build/research/affine';
const BASES: [string, string][] = [
	['crc32c', 'crc32c'],
	['crc16', 'crc16'],
	['crc64', 'crc64'],
	['poly31', 'poly31'],
	['lcg', 'lcg'],
	['adler32', 'adler32'],
	['xlcg', 'xlcg'],
	['xshift', 'xshift'],
	['xsbox', 'xsbox'],
	['xfeed', 'xfeed'],
	['miniz-crc32', 'mz_crc32'],
	['fnv1a', 'fnv1a'],
	['miniz-adler32', 'mz_adler32']
];

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
const clone = (n: Node): Node => (typeof n === 'string' ? n : n.map(clone));

interface Site {
	kind: string;
	apply: () => void;
	undo: () => void;
}

const NONCOMM = new Set(
	['sub', 'shl', 'shr_u', 'shr_s', 'rem_u', 'rem_s', 'div_u', 'div_s', 'rotl', 'rotr'].flatMap(
		(o) => [`i32.${o}`, `i64.${o}`]
	)
);
const REL = ['eq', 'ne', 'lt_u', 'lt_s', 'le_u', 'le_s', 'gt_u', 'gt_s', 'ge_u', 'ge_s'];
const LOADS: Record<string, string[]> = {
	'i32.load8_u': ['i32.load8_s', 'i32.load16_u', 'i32.load16_s', 'i32.load'],
	'i32.load8_s': ['i32.load8_u', 'i32.load16_s'],
	'i32.load16_u': ['i32.load16_s', 'i32.load8_u', 'i32.load'],
	'i32.load16_s': ['i32.load16_u'],
	'i32.load': ['i32.load8_u', 'i32.load16_u', 'i32.load8_s'],
	'i64.load8_u': ['i64.load8_s', 'i64.load16_u', 'i64.load32_u'],
	'i64.load16_u': ['i64.load8_u', 'i64.load32_u'],
	'i64.load32_u': ['i64.load32_s', 'i64.load16_u'],
	'i64.load': ['i64.load32_u', 'i64.load8_u']
};
const STORES: Record<string, string[]> = {
	'i32.store8': ['i32.store16', 'i32.store'],
	'i32.store16': ['i32.store8', 'i32.store'],
	'i32.store': ['i32.store8', 'i32.store16'],
	'i64.store': ['i64.store32', 'i64.store8'],
	'i64.store8': ['i64.store16', 'i64.store32']
};
const STMT = /^(local\.set|i32\.store|i64\.store|br_if|if|drop|call|global\.set|memory\.)/;

function sites(root: Node): Site[] {
	const out: Site[] = [];
	const labels = new Set<string>();
	const locals = new Set<string>();
	const scan = (n: Node) => {
		if (typeof n === 'string') {
			if (/^\$\d+$/.test(n)) locals.add(n);
			return;
		}
		if (/^(block|loop)$/.test(String(n[0])) && typeof n[1] === 'string' && n[1].startsWith('$'))
			labels.add(n[1]);
		n.forEach(scan);
	};
	scan(root);
	const L = [...locals];
	const walk = (n: Node, inFunc: boolean) => {
		if (typeof n === 'string') return;
		const head = n[0];
		const fn = inFunc || head === 'func';
		if (fn && typeof head === 'string') {
			const rep = (kind: string, to: Node[]) => {
				const saved = [...n];
				out.push({
					kind,
					apply: () => n.splice(0, n.length, ...to),
					undo: () => n.splice(0, n.length, ...saved)
				});
			};
			if (NONCOMM.has(head) && n.length === 3) rep('opswap', [head, n[2]!, n[1]!]);
			const rel = /^i(32|64)\.(eq|ne|lt_u|lt_s|le_u|le_s|gt_u|gt_s|ge_u|ge_s)$/.exec(head);
			if (rel)
				for (const r of REL)
					if (r !== rel[2] && (r.endsWith('_s') || rel[2]!.endsWith('_s')))
						rep('rel', [`i${rel[1]}.${r}`, ...n.slice(1)]);
			for (const to of LOADS[head] ?? []) rep('loadw', [to, ...n.slice(1)]);
			for (const to of STORES[head] ?? []) rep('storew', [to, ...n.slice(1)]);
			if (/^i(32|64)\.(load|store)/.test(head)) {
				const k = n.findIndex(
					(x, i) => i > 0 && typeof x === 'string' && x.startsWith('offset=')
				);
				const cur = k < 0 ? 0 : Number((n[k] as string).slice(7));
				const body = k < 0 ? n.slice(1) : [...n.slice(1, k), ...n.slice(k + 1)];
				for (const d of [2, 3, 8, 255, 65535, 65536])
					rep('offset', [head, `offset=${cur + d}`, ...body]);
				if (/^i(32|64)\.load/.test(head) && cur > 0) rep('offset-neg', [head, ...body]);
				const al = n.findIndex((x, i) => i > 0 && typeof x === 'string' && x.startsWith('align='));
				if (al < 0) rep('align', [head, 'align=1', ...n.slice(1)]);
			}
			if ((head === 'br_if' || head === 'if') && n.length >= 3) {
				const ci = head === 'br_if' ? 2 : n.findIndex((x, i) => i > 0 && Array.isArray(x));
				if (ci > 0 && Array.isArray(n[ci])) {
					const c = n[ci]!;
					rep('invcond', [...n.slice(0, ci), ['i32.eqz', c], ...n.slice(ci + 1)]);
				}
			}
			if (head === 'br_if' && typeof n[1] === 'string')
				for (const l of labels)
					if (l !== n[1]) rep('brdepth', ['br_if', l, ...n.slice(2)]);
			if (head === 'if' && n.length >= 4) {
				const arms = n.map((x, i) => (Array.isArray(x) && /^(then|else)$/.test(String(x[0])) ? i : -1)).filter((i) => i > 0);
				if (arms.length === 2) {
					const a = n[arms[0]!] as Node[];
					const b = n[arms[1]!] as Node[];
					const copy = [...n];
					copy[arms[0]!] = ['then', ...b.slice(1)];
					copy[arms[1]!] = ['else', ...a.slice(1)];
					rep('ifarms', copy);
				}
			}
			if (head === 'select' && n.length >= 4)
				rep('selarms', ['select', n[2]!, n[1]!, ...n.slice(3)]);
			if (head === 'i64.extend_i32_u') rep('extend', ['i64.extend_i32_s', ...n.slice(1)]);
			if (head === 'i64.extend_i32_s') rep('extend', ['i64.extend_i32_u', ...n.slice(1)]);
			if (/^local\.(get|set|tee)$/.test(head) && typeof n[1] === 'string' && L.length > 1)
				for (const l of L)
					if (l !== n[1]) rep('localswap', [head, l, ...n.slice(2)]);
			if ((head === 'i32.const' || head === 'i64.const') && typeof n[1] === 'string') {
				const w = head === 'i32.const' ? 32 : 64;
				const v = BigInt(n[1]);
				const cand: bigint[] = [
					v ^ (1n << BigInt(w - 1)),
					v ^ 0xffn,
					v ^ 0xffffn,
					v | 0x100n,
					v + 255n,
					v - 255n,
					v * 3n,
					-v,
					255n,
					0xffffn,
					v >> 1n,
					v << 1n
				];
				for (const x of cand) {
					const s = BigInt.asIntN(w, x).toString();
					if (s !== n[1]) rep('const', [head, s]);
				}
			}
			if (head === 'block' || head === 'loop' || head === 'func') {
				for (let i = 1; i < n.length; i++) {
					const c = n[i];
					if (Array.isArray(c) && STMT.test(String(c[0]))) {
						const saved = c.slice();
						out.push({
							kind: 'drop-stmt',
							apply: () => c.splice(0, c.length, 'nop'),
							undo: () => c.splice(0, c.length, ...saved)
						});
						const ref = n;
						const copy = clone(c);
						out.push({
							kind: 'dup-stmt',
							apply: () => ref.splice(ref.indexOf(c) + 1, 0, copy),
							undo: () => ref.splice(ref.indexOf(copy), 1)
						});
					}
					if (Array.isArray(c) && c[0] === 'local.set' && Array.isArray(c[2])) {
						const saved = c.slice();
						out.push({
							kind: 'set-to-drop',
							apply: () => c.splice(0, c.length, 'drop', saved[2]!),
							undo: () => c.splice(0, c.length, ...saved)
						});
					}
				}
			}
		}
		for (const child of n) walk(child, fn);
	};
	walk(root, false);
	return out;
}

// raw byte edits that still validate
function codeRange(b: Uint8Array): [number, number] {
	let p = 8;
	const leb = () => {
		let r = 0;
		let s = 0;
		for (;;) {
			const x = b[p++]!;
			r |= (x & 127) << s;
			s += 7;
			if (!(x & 128)) return r >>> 0;
		}
	};
	while (p < b.length) {
		const id = b[p++]!;
		const len = leb();
		if (id === 10) return [p, p + len];
		p += len;
	}
	return [0, 0];
}

const PER_TEXT = Number(process.argv[2] ?? 100);
const PER_BYTE = Number(process.argv[3] ?? 40);
const mt = new Manifest('bm-text');
const mb = new Manifest('bm-byte');
const r = mulberry(4242);
const stats: Record<string, Record<string, number>> = {};
for (const [name, entry] of BASES) {
	const base = new Uint8Array(readFileSync(join(dir, `${name}.wasm`)));
	const basePath = join(dir, `${name}.wasm`);
	// text mutation
	const tree = parse(toText(base));
	const list = sites(tree);
	const order = list.map((_, i) => i).sort(() => r() - 0.5);
	const perKind = new Map<string, number>();
	const cap = Math.ceil(PER_TEXT / 5);
	let kept = 0;
	let tried = 0;
	for (const i of order) {
		if (kept >= PER_TEXT || tried > PER_TEXT * 12) break;
		const s = list[i]!;
		if ((perKind.get(s.kind) ?? 0) >= cap) continue;
		tried++;
		s.apply();
		const text = print(tree);
		s.undo();
		let bytes: Uint8Array;
		try {
			bytes = wat(text);
		} catch {
			continue;
		}
		if (mt.add('bm-text', `bm-text/${name}/${kept}-${s.kind}`, bytes, { entry, base: basePath, note: `${name} ${s.kind}` })) {
			kept++;
			perKind.set(s.kind, (perKind.get(s.kind) ?? 0) + 1);
			(stats[name] ??= {})[s.kind] = (stats[name]![s.kind] ?? 0) + 1;
		}
	}
	// byte mutation
	const [lo, hi] = codeRange(base);
	let k = 0;
	let t2 = 0;
	while (k < PER_BYTE && t2 < PER_BYTE * 400 && hi > lo) {
		t2++;
		const pos = lo + Math.floor(r() * (hi - lo));
		const b = Uint8Array.from(base);
		const o = b[pos]!;
		const choices = [o ^ 1, o ^ 2, o ^ 4, o ^ 8, (o + 1) & 255, (o - 1) & 255, Math.floor(r() * 256)];
		b[pos] = choices[Math.floor(r() * choices.length)]!;
		if (b[pos] === o || !WebAssembly.validate(b)) continue;
		if (mb.add('bm-byte', `bm-byte/${name}/${k}-p${pos - lo}`, b, { entry, base: basePath })) k++;
	}
	console.log(name, 'text', kept, 'byte', k, JSON.stringify(stats[name]));
}
console.log('bm-text', mt.count, 'dupes', mt.dupes, 'invalid', mt.invalid);
console.log('bm-byte', mb.count, 'dupes', mb.dupes, 'invalid', mb.invalid);
