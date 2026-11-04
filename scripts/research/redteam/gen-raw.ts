import { outputDirectory, runBatch, type Entry } from './lib.ts';

const dir = outputDirectory();

// hand-assembled stack-style binaries: pending operands under void statements, which binaryen must reorder
const leb = (n: number) => {
	const out: number[] = [];
	do {
		let b = n & 127;
		n >>>= 7;
		if (n) b |= 128;
		out.push(b);
	} while (n);
	return out;
};
const sleb = (n: number) => {
	const out: number[] = [];
	for (;;) {
		const b = n & 127;
		n >>= 7;
		if ((n === 0 && !(b & 64)) || (n === -1 && b & 64)) {
			out.push(b);
			return out;
		}
		out.push(b | 128);
	}
};
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const str = (s: string) => [...leb(s.length), ...Buffer.from(s)];
const body = (locals: number[][], code: number[]) => {
	const inner = [...vec(locals), ...code, 0x0b];
	return [...leb(inner.length), ...inner];
};
const get = (i: number) => [0x20, ...leb(i)];
const set = (i: number) => [0x21, ...leb(i)];
const tee = (i: number) => [0x22, ...leb(i)];
const k = (n: number) => [0x41, ...sleb(n)];
const XOR = [0x73];
const SHL = [0x74];
const SHRS = [0x75];
const SHRU = [0x76];
const AND = [0x71];
const LOAD8 = [0x2d, 0x00, 0x00];
const blockI32 = (code: number[]) => [0x02, 0x7f, ...code, 0x0b];

const module = (
	stepCode: number[] | undefined,
	updateCode: number[],
	updateLocals: number[][] = []
) => {
	const types = section(
		1,
		vec([
			[0x60, 2, 0x7f, 0x7f, 1, 0x7f],
			[0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f]
		])
	);
	const funcs = stepCode ? [0, 1] : [1];
	const fsec = section(3, vec(funcs.map((t) => [t])));
	const mem = section(5, [1, 0, 32]);
	const exps = stepCode
		? vec([
				[...str('memory'), 2, 0],
				[...str('transition'), 0, 0],
				[...str('update'), 0, 1]
			])
		: vec([
				[...str('memory'), 2, 0],
				[...str('update'), 0, 0]
			]);
	const bodies = stepCode
		? [body([[1, 0x7f]], stepCode), body(updateLocals, updateCode)]
		: [body(updateLocals, updateCode)];
	return Uint8Array.from([
		0,
		0x61,
		0x73,
		0x6d,
		1,
		0,
		0,
		0,
		...types,
		...fsec,
		...mem,
		...section(7, exps),
		...section(10, vec(bodies))
	]);
};

const callIdx = 0;
const wrapper = [
	0x02,
	0x40,
	...get(2),
	0x45,
	0x0d,
	0,
	0x03,
	0x40,
	...get(0),
	...get(1),
	...LOAD8,
	0x10,
	callIdx,
	...set(0),
	...get(1),
	...k(1),
	0x6a,
	...set(1),
	...get(2),
	...k(-1),
	0x6a,
	...tee(2),
	0x0d,
	0,
	0x0b,
	0x0b,
	...get(0)
];
const loopFn = (stmts: number[], pre: number[] = [], post: number[] = []) => [
	0x02,
	0x40,
	...get(2),
	0x45,
	0x0d,
	0,
	...pre,
	0x03,
	0x40,
	...stmts,
	...get(1),
	...k(1),
	0x6a,
	...set(1),
	...get(2),
	...k(-1),
	0x6a,
	...tee(2),
	0x0d,
	0,
	0x0b,
	...post,
	0x0b,
	...get(0)
];

const steps: [string, string, number[]][] = [
	[
		'old-xor-new',
		'get0 get1 set0 get0 xor',
		[...get(0), ...get(1), ...set(0), ...get(0), ...XOR]
	],
	[
		'old-xor-const',
		'get0 const5 set0 get0 xor',
		[...get(0), ...k(5), ...set(0), ...get(0), ...XOR]
	],
	[
		'two-pending',
		'get0 get1 const3 set0 const9 set1 xor',
		[...get(0), ...get(1), ...k(3), ...set(0), ...k(9), ...set(1), ...XOR]
	],
	[
		'pending-tee',
		'get0 get1 tee0 const1 shl xor get0 xor',
		[...get(0), ...get(1), ...tee(0), ...k(1), ...SHL, ...XOR, ...get(0), ...XOR]
	],
	[
		'pending-block',
		'get0 block(get1 set0 get0 shl1) xor',
		[...get(0), ...blockI32([...get(1), ...set(0), ...get(0), ...k(1), ...SHL]), ...XOR]
	],
	[
		'pending-right',
		'get1 get0 const7 set0 xor',
		[...get(1), ...get(0), ...k(7), ...set(0), ...XOR]
	],
	[
		'pending-shl',
		'get0 get1 set0 const1 shl',
		[...get(0), ...get(1), ...set(0), ...k(1), ...SHL]
	],
	[
		'pending-and',
		'get0 get1 set0 const 0xf0 and then xor get0',
		[...get(0), ...get(1), ...set(0), ...k(0xf0), ...AND, ...get(0), ...XOR]
	],
	[
		'pending-sar',
		'get0 get1 set0 sar 31 xor get1',
		[...get(0), ...get(1), ...set(0), ...k(31), ...SHRS, ...get(1), ...XOR]
	],
	[
		'pending-three',
		'get0 get1 set2 get0 get2 set0 xor xor',
		[
			...get(0),
			...get(1),
			...set(2),
			...get(0),
			...get(2),
			...set(0),
			...get(0),
			...XOR,
			...XOR
		]
	],
	[
		'tee-chain',
		'get0 tee2 get2 shr_u 3 xor get0',
		[...get(0), ...tee(2), ...get(2), ...k(3), ...SHRU, ...XOR, ...get(0), ...XOR]
	],
	[
		'swap',
		'swap state and byte through local 2',
		[...get(0), ...set(2), ...get(1), ...set(0), ...get(2), ...get(0), ...XOR]
	]
];

const entries: Entry[] = [];
const MV = (code: number[]) => [0x02, 0x00, ...code, 0x0b];
steps.push([
	'multivalue-block',
	'get0 get1 block(type 0, params) xor',
	[...get(0), ...get(1), ...MV(XOR)]
]);
steps.push([
	'multivalue-block-shl',
	'get0 get1 block(type 0) set1 const1 shl end',
	[...get(0), ...get(1), ...MV([...set(1), ...k(1), ...SHL])]
]);
steps.push([
	'multivalue-loop',
	'get0 get1 loop(type 0) xor end',
	[...get(0), ...get(1), 0x03, 0x00, ...XOR, 0x0b]
]);
for (const [id, note, code] of steps) {
	entries.push({
		id: `raw/${id}/stream`,
		group: 'raw',
		note,
		source: `step code ${code.map((b) => b.toString(16)).join(' ')}`,
		bytes: module(code, wrapper)
	});
}
// loop forms: pending s under a void local.set of the byte
const loopCases: [string, string, number[], number[], number[]][] = [
	[
		'pending-byte',
		'get0 (get1 load set3) get3 xor set0',
		[...get(0), ...get(1), ...LOAD8, ...set(3), ...get(3), ...XOR, ...set(0)],
		[],
		[]
	],
	[
		'pending-two',
		'get0 get1 load set3 get3 xor shl1 set0',
		[...get(0), ...get(1), ...LOAD8, ...set(3), ...get(3), ...XOR, ...k(1), ...SHL, ...set(0)],
		[],
		[]
	],
	[
		'pre-pending',
		'pre via pending operand',
		[...get(1), ...LOAD8, ...set(3), ...get(0), ...get(3), ...XOR, ...set(0)],
		[...get(0), ...k(-1), ...XOR, ...set(0)],
		[...get(0), ...k(-1), ...XOR, ...set(0)]
	],
	[
		'pre-pending-tricky',
		'pre with a pending get under set',
		[...get(1), ...LOAD8, ...set(3), ...get(0), ...get(3), ...XOR, ...set(0)],
		[...get(0), ...k(5), ...set(0), ...get(0), ...XOR, ...set(0)],
		[...get(0), ...k(5), ...XOR, ...set(0)]
	],
	[
		'dead-store',
		'local 3 set then overwritten',
		[
			...get(1),
			...LOAD8,
			...set(3),
			...k(7),
			...set(3),
			...get(0),
			...get(3),
			...XOR,
			...set(0)
		],
		[],
		[]
	],
	[
		'load-twice',
		'two byte loads xor to zero',
		[...get(0), ...get(1), ...LOAD8, ...get(1), ...LOAD8, ...XOR, ...XOR, ...set(0)],
		[],
		[]
	]
];
for (const [id, note, stmts, pre, post] of loopCases) {
	entries.push({
		id: `raw/${id}/loop`,
		group: 'raw',
		note,
		source: `loop code ${stmts.map((b) => b.toString(16)).join(' ')}`,
		bytes: module(undefined, loopFn(stmts, pre, post), [[3, 0x7f]])
	});
}
runBatch(entries, dir, 'raw');
