import { buildWat, outputDirectory, runBatch, type Entry } from './lib.ts';

// operator-semantics cases; each body is an i32 expression over state S and byte B
interface K {
	S: string;
	B: string;
	g1: string;
	g2: string;
	s1: (x: string) => string;
	s2: (x: string) => string;
	t1: (x: string) => string;
	t2: (x: string) => string;
}
const kit = (t1: number, t2: number, byte: string): K => ({
	S: '(local.get 0)',
	B: byte,
	g1: `(local.get ${t1})`,
	g2: `(local.get ${t2})`,
	s1: (x) => `(local.set ${t1} ${x})`,
	s2: (x) => `(local.set ${t2} ${x})`,
	t1: (x) => `(local.tee ${t1} ${x})`,
	t2: (x) => `(local.tee ${t2} ${x})`
});

export const streamWat = (
	body: string
) => `(func $step (export "transition") (param i32 i32) (result i32) (local i32 i32) ${body})
(func $update (export "update") (param i32 i32 i32) (result i32)
	(block $done (br_if $done (i32.eqz (local.get 2)))
		(loop $again
			(local.set 0 (call $step (local.get 0) (i32.load8_u (local.get 1))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`;

export const loopWat = (
	body: string,
	pre = '',
	post = ''
) => `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		${pre}
		(loop $l
			(local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 ${body})
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1)))))
		${post})
	(local.get 0))`;

const c = (v: number) => `(i32.const ${v})`;
const x = (a: string, b: string) => `(i32.xor ${a} ${b})`;
const and = (a: string, b: string) => `(i32.and ${a} ${b})`;
const shu = (a: string, n: number) => `(i32.shr_u ${a} ${c(n)})`;
const shs = (a: string, n: number) => `(i32.shr_s ${a} ${c(n)})`;
const shl = (a: string, n: number) => `(i32.shl ${a} ${c(n)})`;
const sub = (a: string, b: string) => `(i32.sub ${a} ${b})`;

export const cases: { id: string; note: string; body: (k: K) => string }[] = [];
const add = (id: string, note: string, body: (k: K) => string) => cases.push({ id, note, body });

// 1. shift counts
for (const n of [0, 1, 31, 32, 33, -1, -31, 63, 256, 0x7fffffff]) {
	add(`shu-${n}`, `shr_u by ${n} on state xor byte`, (k) => x(shu(x(k.S, k.B), n), k.S));
	add(`shs-${n}`, `shr_s by ${n} on state xor byte`, (k) => x(shs(x(k.S, k.B), n), shl(k.S, 3)));
	add(`shl-${n}`, `shl by ${n} on state xor byte`, (k) => x(shl(x(k.S, k.B), n), shu(k.S, 5)));
}
// 2. negate idiom and variants
const crc = (k: K, neg: string) => x(shu(x(k.S, k.B), 1), and(c(0x82f63b78), neg));
add('neg-bit0', 'sub 0 (s & 1): the real idiom', (k) => crc(k, sub(c(0), and(k.S, c(1)))));
add('neg-bit0-swapped', 'and with the constant on the right', (k) =>
	x(shu(x(k.S, k.B), 1), and(sub(c(0), and(k.S, c(1))), c(0x82f63b78)))
);
add('neg-mask3', 'sub 0 (s & 3), not a single bit', (k) => crc(k, sub(c(0), and(k.S, c(3)))));
add('neg-mask2', 'sub 0 (s & 2): bit 1 only', (k) => crc(k, sub(c(0), and(k.S, c(2)))));
add('neg-full', 'sub 0 s', (k) => crc(k, sub(c(0), k.S)));
add('neg-byte', 'sub 0 byte', (k) => x(k.S, sub(c(0), k.B)));
add('neg-top', 'sub 0 (s>>>31)', (k) =>
	x(shu(x(k.S, k.B), 1), and(c(0x82f63b78), sub(c(0), shu(k.S, 31))))
);
add('neg-signbit-sar', 'sub 0 (s>>31 signed)', (k) =>
	x(shu(x(k.S, k.B), 1), and(c(0x82f63b78), sub(c(0), shs(k.S, 31))))
);
add('neg-hi', 'sub 0 (s & 0x80000000)', (k) =>
	x(k.B, and(c(0x82f63b78), sub(c(0), and(k.S, c(-2147483648)))))
);
add('neg-const-zero-left', 'left operand (s & 0) is symbolically zero', (k) =>
	x(k.B, and(c(0xffff), sub(and(k.S, c(0)), and(k.S, c(1)))))
);
add('neg-left-nonzero', 'sub s (s & 1)', (k) => x(k.B, sub(k.S, and(k.S, c(1)))));
add('neg-one', 'sub 0 1 constant', (k) => x(k.S, sub(c(0), c(1))));
add('neg-and-after', 'and then negate of xor of two bits', (k) =>
	x(k.B, sub(c(0), x(and(k.S, c(1)), and(shu(k.S, 4), c(1)))))
);
add('neg-and-xor-bit-low', 'negate (bit0 xor const 1)', (k) =>
	x(k.S, and(c(0x1234), sub(c(0), x(and(k.S, c(1)), c(1)))))
);
// 3. and, xor
add('and-const-left', 'and const left', (k) => x(and(c(0x0f0f0f0f), k.S), k.B));
add('and-const-right', 'and const right', (k) => x(and(k.S, c(0xf0f0f0f0 | 0)), k.B));
add('and-both-const', 'and of two constants', (k) => x(k.S, and(c(0x55), c(0x33))));
add('and-vars', 'and of state and byte', (k) => and(k.S, k.B));
add('and-self', 'and of state with itself', (k) => x(and(k.S, k.S), k.B));
add('and-neg1', 'and with -1', (k) => x(and(k.S, c(-1)), k.B));
add('xor-const', 'xor with constants', (k) => x(x(k.S, c(0xdeadbeef | 0)), k.B));
add('xor-self', 'xor state with state is zero', (k) => x(x(k.S, k.S), k.B));
add('xor-const-twice', 'constants cancel', (k) => x(x(k.S, c(5)), x(k.B, c(5))));
// 4. tee and locals
add('tee-reuse', 'tee then read', (k) => x(k.t1(x(k.S, k.B)), shu(k.g1, 3)));
add('tee-reassign', 'left reads old local, right reassigns', (k) =>
	x(k.g1, `(block (result i32) ${k.s1(c(5))} ${k.g1})`)
);
add('tee-reassign2', 'block assigns then reads', (k) =>
	x(`(block (result i32) ${k.s1(k.S)} ${k.g1})`, x(k.t1(k.B), k.g1))
);
add('tee-state-alias', 'tee the state local in right operand', (k) =>
	x(k.S, `(local.tee 0 ${x(k.S, k.B)})`)
);
add('tee-state-alias-r', 'tee the state local in left operand', (k) =>
	x(`(local.tee 0 ${x(k.S, k.B)})`, k.S)
);
add('tee-two', 'two tees', (k) => x(k.t1(shl(k.S, 1)), k.t2(x(k.g1, k.B))));
add('tee-order', 'right uses local set in left', (k) => x(k.t1(shu(k.S, 7)), shl(k.g1, 2)));
add('tee-order-rev', 'left uses old local, right sets', (k) => x(shl(k.g1, 2), k.t1(shu(k.S, 7))));
add('local-uninit', 'read unassigned local (zero)', (k) => x(k.S, x(k.g2, k.B)));
add(
	'set-in-block-first',
	'block sets local then returns xor',
	(k) => `(block (result i32) ${k.s1(shu(k.S, 2))} ${k.s2(k.B)} ${x(k.g1, k.g2)})`
);
add(
	'block-nested',
	'nested value blocks',
	(k) => `(block (result i32) (block (result i32) ${x(k.S, k.B)}))`
);
add('block-nested-set', 'nested block with set', (k) =>
	x(`(block (result i32) ${k.s1(k.S)} (block (result i32) ${shu(k.g1, 1)}))`, k.B)
);
add(
	'block-empty-last-set',
	'block with leading set then expr',
	(k) => `(block (result i32) ${k.s1(c(7))} ${x(k.g1, k.S)})`
);
add(
	'param-reassign-byte',
	'byte param reassigned',
	(k) => `(block (result i32) (local.set 1 ${x(k.B, c(9))}) ${x(k.S, '(local.get 1)')})`
);
// 5. unsupported ops: expected refusal; some are valid affine functions
add('select', 'select on a constant condition', (k) => `(select ${k.S} ${k.B} ${c(1)})`);
add('rotl-const', 'rotl by constant (linear)', (k) => x(`(i32.rotl ${k.S} ${c(5)})`, k.B));
add('rotr-const', 'rotr by constant (linear)', (k) => x(`(i32.rotr ${k.S} ${c(31)})`, k.B));
add('clz', 'clz (nonlinear)', (k) => x(`(i32.clz ${k.S})`, k.B));
add('ctz', 'ctz (nonlinear)', (k) => x(`(i32.ctz ${k.S})`, k.B));
add('popcnt-parity', 'parity via popcnt & 1 (linear)', (k) =>
	x(and(`(i32.popcnt ${k.S})`, c(1)), k.B)
);
add('popcnt', 'popcnt (nonlinear)', (k) => x(`(i32.popcnt ${k.S})`, k.B));
add('eqz', 'eqz as data', (k) => x(`(i32.eqz ${k.S})`, k.B));
add('eqz-const', 'eqz of constant zero', (k) => x(`(i32.eqz ${c(0)})`, x(k.S, k.B)));
add('eq-self', 'state == state as data (constant 1)', (k) =>
	x(`(i32.eq ${k.S} ${k.S})`, x(k.S, k.B))
);
add('lt-u', 'comparison as data', (k) => x(`(i32.lt_u ${k.S} ${c(1000)})`, x(k.S, k.B)));
add('mul-pow2', 'mul by 4 (linear)', (k) => x(`(i32.mul ${k.S} ${c(4)})`, k.B));
add('mul-odd', 'mul by 3 (z2w)', (k) => x(`(i32.mul ${k.S} ${c(3)})`, k.B));
add('mul-self', 'state times state', (k) => `(i32.mul ${k.S} ${k.S})`);
add(
	'add-xor-disjoint',
	'add of disjoint masked bits (linear)',
	(k) => `(i32.add ${and(k.S, c(0xf0))} ${and(k.B, c(0x0f))})`
);
add('add-same-bit', 'add that carries', (k) => `(i32.add ${and(k.S, c(0xff))} ${k.B})`);
add(
	'or-disjoint',
	'or of disjoint masked bits (linear)',
	(k) => `(i32.or ${and(k.S, c(0xf0))} ${and(k.B, c(0x0f))})`
);
add('or-overlap', 'or of overlapping bits', (k) => `(i32.or ${k.S} ${k.B})`);
add('add-const', 'add constant', (k) => x(`(i32.add ${k.S} ${c(1)})`, k.B));
add('shl-var', 'shift by variable', (k) => `(i32.shl ${k.S} ${and(k.B, c(7))})`);
add(
	'shl-var-zero',
	'shift by variable that is zero',
	(k) => `(i32.xor (i32.shl ${k.S} ${and(k.B, c(0))}) ${k.B})`
);
add('shl-const-lhs', 'shift of a constant by state', (k) => `(i32.shl ${c(1)} ${and(k.S, c(0))})`);
add('div', 'unsigned division', (k) => `(i32.div_u ${x(k.S, k.B)} ${c(3)})`);
add('rem', 'remainder', (k) => `(i32.rem_u ${x(k.S, k.B)} ${c(65521)})`);
add('ext8', 'extend8_s', (k) => x(`(i32.extend8_s ${k.S})`, k.B));
add(
	'wrap-i64',
	'through i64 xor',
	(k) => `(i32.wrap_i64 (i64.xor (i64.extend_i32_u ${k.S}) (i64.extend_i32_u ${k.B})))`
);
add('drop-expr', 'block with drop', (k) => `(block (result i32) (drop ${k.B}) ${k.S})`);
add('nop', 'block with nop', (k) => `(block (result i32) (nop) ${x(k.S, k.B)})`);
add(
	'if-else',
	'if on constant',
	(k) => `(if (result i32) ${c(1)} (then ${x(k.S, k.B)}) (else ${k.S}))`
);
add('named-block', 'named block, no branch', (k) => `(block $b (result i32) ${x(k.S, k.B)})`);
add('trunc-const-i32', 'large constant', (k) => x(k.S, x(k.B, c(-2147483648))));
add('byte-high-bits', 'shift byte into high bits', (k) => x(k.S, shl(k.B, 24)));
add('byte-high-sar', 'signed shift of byte shifted high', (k) => x(shs(shl(k.B, 24), 24), k.S));
add('byte-shu-big', 'byte shifted right', (k) => x(shu(k.B, 3), shs(k.S, 1)));
add('state-const-only', 'ignores state', (k) => x(k.B, c(0x1234)));
add('identity', 'returns the state', (k) => k.S);
add('byte-only', 'returns the byte', (k) => k.B);
add('byte-and-mask', 'byte masked', (k) => x(k.S, and(k.B, c(0x0f))));
add('state-shr-sar-mix', 'sar and shr mix', (k) => x(shs(k.S, 31), x(shu(k.S, 31), k.B)));
add('state-sar-1-over-and', 'sar then and', (k) => and(shs(k.S, 4), c(0x00ffff00)));

// random fuzz: a tree generator in the supported grammar plus rare unsupported nodes
let seed = 0x5eed1234;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const shifts = [0, 1, 2, 7, 8, 15, 16, 31, 32, 33, 63, -1, -2, -31, 65];
const masks = [
	0,
	1,
	3,
	0xff,
	0xff00,
	0x80000000 | 0,
	0x7fffffff,
	-1,
	0x82f63b78 | 0,
	0xdeadbeef | 0
];
function gen(k: K, depth: number, wild: boolean): string {
	if (depth <= 0 || rnd() < 0.15) return pick([k.S, k.B, k.S, c(pick(masks)), k.g1, k.g2]);
	const r = rnd();
	const d = depth - 1;
	if (r < 0.28) return x(gen(k, d, wild), gen(k, d, wild));
	if (r < 0.4)
		return rnd() < 0.5
			? and(c(pick(masks)), gen(k, d, wild))
			: and(gen(k, d, wild), c(pick(masks)));
	if (r < 0.55) return `(i32.shr_u ${gen(k, d, wild)} ${c(pick(shifts))})`;
	if (r < 0.7) return `(i32.shr_s ${gen(k, d, wild)} ${c(pick(shifts))})`;
	if (r < 0.82) return `(i32.shl ${gen(k, d, wild)} ${c(pick(shifts))})`;
	if (r < 0.88) return sub(c(0), and(gen(k, d, wild), c(pick([1, 2, 4, 0x80000000 | 0, 3]))));
	if (r < 0.93) return rnd() < 0.5 ? k.t1(gen(k, d, wild)) : k.t2(gen(k, d, wild));
	if (r < 0.97)
		return `(block (result i32) ${rnd() < 0.5 ? k.s1(gen(k, d, wild)) : k.s2(gen(k, d, wild))} ${gen(k, d, wild)})`;
	if (!wild) return x(gen(k, d, wild), gen(k, d, wild));
	return pick([
		`(i32.rotl ${gen(k, d, wild)} ${c(pick(shifts))})`,
		`(i32.add ${gen(k, d, wild)} ${gen(k, d, wild)})`,
		`(i32.or ${gen(k, d, wild)} ${gen(k, d, wild)})`,
		sub(gen(k, d, wild), gen(k, d, wild)),
		`(i32.mul ${gen(k, d, wild)} ${c(pick([2, 4, 8, 3]))})`,
		`(i32.shl ${gen(k, d, wild)} ${and(gen(k, d, wild), c(7))})`
	]);
}
export const fuzz: { id: string; note: string; body: string[] }[] = [];
for (let n = 0; n < 70; n++) {
	const wild = n % 7 === 6;
	const sK = kit(2, 3, '(local.get 1)');
	const lK = kit(4, 5, '(local.get 3)');
	// same random stream for both forms: generate with a snapshot of the seed
	const snap = seed;
	const sBody = gen(sK, 5, wild);
	seed = snap;
	const lBody = gen(lK, 5, wild);
	fuzz.push({
		id: `fuzz-${n}${wild ? 'w' : ''}`,
		note: `random tree depth 5${wild ? ' with unsupported nodes' : ''}`,
		body: [sBody, lBody]
	});
}

/** WAT text of one operator case in the stream or the loop form. */
export const caseWat = (id: string, form: 'stream' | 'loop') => {
	const cs = cases.find((item) => item.id === id);
	if (!cs) throw new Error(`no operator case ${id}`);
	return form === 'stream'
		? streamWat(cs.body(kit(2, 3, '(local.get 1)')))
		: loopWat(cs.body(kit(4, 5, '(local.get 3)')));
};

if (import.meta.main) {
	const dir = outputDirectory();
	const entries: Entry[] = [];
	const push = (id: string, group: string, note: string, source: string) => {
		try {
			entries.push({ id, group, note, source, bytes: buildWat(source) });
		} catch (e) {
			console.log('build failed', id, String(e).split('\n')[0]);
		}
	};
	for (const cs of cases) {
		push(`ops/${cs.id}/stream`, 'operators', cs.note, caseWat(cs.id, 'stream'));
		push(`ops/${cs.id}/loop`, 'operators', cs.note, caseWat(cs.id, 'loop'));
	}
	for (const f of fuzz) {
		push(`${f.id}/stream`, 'fuzz', f.note, streamWat(f.body[0]!));
		push(`${f.id}/loop`, 'fuzz', f.note, loopWat(f.body[1]!));
	}
	runBatch(entries, dir, 'ops');
}
