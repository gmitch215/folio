import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Manifest, toText, wat } from './gen-lib.ts';

// family ds: differential refusal on the REAL accepted subject binaries. One statement is added at
// the top of the function body, at the top of the first loop, or at the end of the first loop body
// (a store into or ahead of the input, a load past the end, a trap on n or on a byte, a scratch
// write, memory.grow, memory.fill or memory.copy over the input). The checker must refuse, or
// its certificate must survive ground truth.
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
	['miniz-crc32', 'mz_crc32']
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
const P = '(local.get $1)';
const N = '(local.get $2)';
const K = (v: number) => `(i32.const ${v})`;
const HOOKS: Record<string, string> = {
	'store-p0': `(i32.store8 ${P} ${K(7)})`,
	'store-p0-xor': `(i32.store8 ${P} (i32.xor (i32.load8_u ${P}) ${K(85)}))`,
	'store-p1': `(i32.store8 (i32.add ${P} ${K(1)}) ${K(7)})`,
	'store-pn': `(i32.store8 (i32.add ${P} ${N}) ${K(7)})`,
	'store-pn-1': `(i32.store8 (i32.add ${P} (i32.sub ${N} ${K(1)})) ${K(7)})`,
	'store-scratch': `(i32.store8 ${K(100)} ${K(1)})`,
	'store-scratch-word': `(i32.store ${K(4096)} ${N})`,
	'load-pn': `(drop (i32.load8_u (i32.add ${P} ${N})))`,
	'load-p-1': `(drop (i32.load8_u (i32.sub ${P} ${K(1)})))`,
	'load-pn-use': `(i32.store8 ${K(100)} (i32.load8_u (i32.add ${P} ${N})))`,
	'trap-n': `(if (i32.eq ${N} ${K(1000)}) (then (unreachable)))`,
	'trap-n-big': `(if (i32.gt_u ${N} ${K(70000)}) (then (unreachable)))`,
	'trap-p0': `(if (i32.eq (i32.load8_u ${P}) ${K(255)}) (then (unreachable)))`,
	'grow0': `(drop (memory.grow ${K(0)}))`,
	'fill1': `(memory.fill ${P} ${K(0)} ${K(1)})`,
	'fill-n': `(memory.fill ${P} ${K(0)} ${N})`,
	'copy1': `(memory.copy ${P} (i32.add ${P} ${K(1)}) ${K(1)})`,
	'nop': '(nop)'
};
const mt = new Manifest('ds');
for (const [name, entry] of BASES) {
	const base = new Uint8Array(readFileSync(join(dir, `${name}.wasm`)));
	const tree = parse(toText(base));
	const find = (n: Node, head: string): Node[] | undefined => {
		if (typeof n === 'string') return undefined;
		if (n[0] === head) return n;
		for (const c of n) {
			const r = find(c, head);
			if (r) return r;
		}
		return undefined;
	};
	const fn = (tree as Node[]).find((c) => Array.isArray(c) && c[0] === 'func') as Node[];
	const loop = find(fn, 'loop');
	const isLoopLabel = (x: Node) => typeof x === 'string' && x.startsWith('$');
	const at = (list: Node[], pos: 'start' | 'end', after: number) => (pos === 'start' ? after : list.length);
	for (const [hn, hook] of Object.entries(HOOKS)) {
		const stmt = parse(hook);
		for (const where of ['func', 'loop-top', 'loop-end']) {
			const target = where === 'func' ? fn : loop;
			if (!target) continue;
			// first child position after the header items
			let first = 1;
			while (first < target.length && (isLoopLabel(target[first]!) || (Array.isArray(target[first]) && /^(export|param|result|local|type)$/.test(String(target[first]![0]))))) first++;
			const pos = where === 'loop-end' ? target.length : first;
			void at;
			const copy = JSON.parse(JSON.stringify(target)) as Node[];
			// edit the live tree and restore
			target.splice(pos, 0, JSON.parse(JSON.stringify(stmt)));
			const text = print(tree);
			target.splice(pos, 1);
			void copy;
			let bytes: Uint8Array;
			try {
				bytes = wat(text);
			} catch (e) {
				if (process.env.DEBUG) console.log(hn, where, String(e).slice(0, 200), text.slice(0, 300));
				continue;
			}
			mt.add('ds', `ds/${name}/${hn}@${where}`, bytes, { entry, base: join(dir, `${name}.wasm`) });
		}
	}
}
console.log('ds', mt.count, 'dupes', mt.dupes, 'invalid', mt.invalid);
