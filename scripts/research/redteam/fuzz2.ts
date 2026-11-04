import { writeFileSync } from 'node:fs';
import { predictEnd } from '../../../src/affine.ts';
import { buildWat, runLoop, runStream } from './lib.ts';

// bulk differential fuzz of the shared evaluator: random supported-grammar trees, accepted ones are run on all byte values
const dir = process.argv[2];
if (!dir) throw new Error('usage: fuzz2.ts OUTPUT_DIRECTORY [BUDGET_MS]');
const budgetMs = Number(process.argv[3] ?? 50000);
const SEED = 0x1badb002;
let seed = SEED;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const pick = <T>(a: T[]): T => a[rnd() % a.length]!;
const c = (v: number) => `(i32.const ${v | 0})`;
const shifts = [
	0, 1, 2, 3, 7, 8, 15, 16, 24, 30, 31, 32, 33, 34, 63, 64, 65, -1, -2, -3, -31, -32, -33,
	0x7fffffff, -0x80000000
];
const masks = [
	0, 1, 2, 3, 0xff, 0xff00, 0x80000000, 0x7fffffff, -1, 0x82f63b78, 0xdeadbeef, 0x00010001,
	0x55555555
];
interface K {
	S: string;
	B: string;
	l1: number;
	l2: number;
}
function gen(k: K, d: number): string {
	if (d <= 0 || rnd() % 7 === 0)
		return pick([
			k.S,
			k.B,
			k.S,
			k.B,
			c(pick(masks)),
			`(local.get ${k.l1})`,
			`(local.get ${k.l2})`
		]);
	const r = rnd() % 100;
	const g = () => gen(k, d - 1);
	if (r < 24) return `(i32.xor ${g()} ${g()})`;
	if (r < 36)
		return rnd() & 1
			? `(i32.and ${c(pick(masks))} ${g()})`
			: `(i32.and ${g()} ${c(pick(masks))})`;
	if (r < 48) return `(i32.shr_u ${g()} ${c(pick(shifts))})`;
	if (r < 58) return `(i32.shr_s ${g()} ${c(pick(shifts))})`;
	if (r < 70) return `(i32.shl ${g()} ${c(pick(shifts))})`;
	if (r < 78)
		return `(i32.sub ${rnd() % 3 ? c(0) : `(i32.and ${g()} ${c(0)})`} ${pick([`(i32.and ${g()} ${c(pick([1, 1, 2, 4, 0x80000000]))})`, `(i32.shr_u ${g()} ${c(31)})`, `(i32.shr_u ${g()} ${c(pick(shifts))})`, g()])})`;
	if (r < 86) return `(local.tee ${pick([k.l1, k.l2, 0])} ${g()})`;
	if (r < 94) return `(block (result i32) (local.set ${pick([k.l1, k.l2, 0])} ${g()}) ${g()})`;
	return `(block (result i32) ${g()})`;
}
const stream = (
	body: string
) => `(func $step (export "transition") (param i32 i32) (result i32) (local i32 i32) ${body})
(func $update (export "update") (param i32 i32 i32) (result i32)
	(block $done (br_if $done (i32.eqz (local.get 2)))
		(loop $again (local.set 0 (call $step (local.get 0) (i32.load8_u (local.get 1))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`;
// loop form: locals are assigned before use through a prologue in the iteration
const loop = (
	body: string
) => `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		(loop $l (local.set 3 (i32.load8_u (local.get 1))) (local.set 4 (i32.const 0)) (local.set 5 (i32.const 0))
			(local.set 0 ${body})
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	(local.get 0))`;

let accepted = 0;
let built = 0;
let wrong = 0;
const log: string[] = [];
const verify = (bytes: Uint8Array, model: any, label: string, src: string) => {
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)));
	const memory = instance.exports.memory as WebAssembly.Memory;
	const heap = new Uint8Array(memory.buffer);
	const update = instance.exports.update as Function;
	const call = (s: number, n: number) => update(s | 0, 1024, n) >>> 0;
	const states = [0, 1, 0x80000000, 0xffffffff, rnd(), rnd(), rnd(), rnd()];
	for (let b = 0; b < 256; b++)
		for (const s of states) {
			heap[1024] = b;
			const whole = call(s, 1);
			const predicted = predictEnd(model, BigInt(s >>> 0), 1, BigInt(call(0, 1)));
			if (predicted !== BigInt(whole))
				return `${label} byte ${b} state ${s >>> 0} whole ${whole} predicted ${predicted}\n${src}`;
		}
	for (let t = 0; t < 40; t++) {
		const n = 2 + (rnd() % 9);
		for (let i = 0; i < n; i++) heap[1024 + i] = rnd() & 255;
		const s = rnd();
		const whole = call(s, n);
		const cut = 1 + (rnd() % (n - 1));
		const first = call(s, cut);
		heap.copyWithin(1024, 1024 + cut, 1024 + n);
		const chain = call(first, n - cut);
		if (chain !== whole) return `${label} chain n ${n} cut ${cut} state ${s >>> 0}\n${src}`;
	}
	return '';
};
const start = Date.now();
for (let n = 0; Date.now() - start < budgetMs; n++) {
	const body = (k: K) => gen(k, 3 + (rnd() % 4));
	const snap = seed;
	const sBody = body({ S: '(local.get 0)', B: '(local.get 1)', l1: 2, l2: 3 });
	seed = snap;
	const lBody = body({ S: '(local.get 0)', B: '(local.get 3)', l1: 4, l2: 5 });
	for (const [form, src, check] of [
		['stream', stream(sBody), runStream],
		['loop', loop(lBody), runLoop]
	] as const) {
		let bytes: Uint8Array;
		try {
			bytes = buildWat(src);
		} catch {
			continue;
		}
		built++;
		const v = check(bytes);
		if (!v.accepted) continue;
		accepted++;
		const failure = verify(bytes, v.model, form, src);
		if (failure) {
			wrong++;
			log.push(failure);
		}
	}
}
writeFileSync(
	`${dir}/fuzz2.json`,
	JSON.stringify(
		{ seed: `0x${SEED.toString(16)}`, budgetMs, built, accepted, wrong, log },
		null,
		1
	),
	{ flag: 'wx' }
);
console.log({ built, accepted, wrong });
if (log.length) console.log(log[0]);
