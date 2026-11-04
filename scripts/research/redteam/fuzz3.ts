import { writeFileSync } from 'node:fs';
import { buildWat, runLoop, truth } from './lib.ts';

// conditioning fuzz for loop-check: identity-wrapped xor constants before and after, equal or off by a few bits
const dir = process.argv[2];
if (!dir) throw new Error('usage: fuzz3.ts OUTPUT_DIRECTORY [BUDGET_MS]');
const budgetMs = Number(process.argv[3] ?? 45000);
const SEED = 0xfeedbeef;
let seed = SEED;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const pick = <T>(a: T[]): T => a[rnd() % a.length]!;
const c = (v: number) => `(i32.const ${v | 0})`;
const wrapId = (x: string, d: number): string => {
	if (d <= 0) return x;
	const inner = wrapId(x, d - 1);
	return pick([
		inner,
		`(i32.and ${inner} ${c(-1)})`,
		`(i32.and ${c(-1)} ${inner})`,
		`(i32.shl ${inner} ${c(pick([32, 64, -32, 0]))})`,
		`(i32.shr_u ${inner} ${c(pick([32, 64, -32, 0]))})`,
		`(i32.shr_s ${inner} ${c(pick([32, 96, 0]))})`,
		`(i32.xor ${inner} (i32.and (local.get 0) ${c(0)}))`,
		`(block (result i32) (local.set 4 ${inner}) (local.get 4))`,
		`(local.tee 5 ${inner})`,
		`(i32.xor (i32.xor ${inner} ${c(0x1234)}) ${c(0x1234)})`
	]);
};
const stage = (k: number) => {
	let x = wrapId('(local.get 0)', 2 + (rnd() % 3));
	x = `(i32.xor ${x} ${c(k)})`;
	if (rnd() % 3 === 0) x = wrapId(x, 2);
	return `(local.set 0 ${x})`;
};
const make = (
	pre: string,
	post: string
) => `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32)
	(block $g (br_if $g (i32.eqz (local.get 2)))
		${pre}
		(loop $l (local.set 3 (i32.load8_u (local.get 1)))
			(local.set 0 (i32.xor (i32.shl (i32.xor (local.get 0) (local.get 3)) (i32.const 1)) (i32.shr_u (local.get 0) (i32.const 3))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1)))))
		${post})
	(local.get 0))`;
let built = 0;
let accepted = 0;
let wrong = 0;
let refusedEqual = 0;
const log: string[] = [];
const start = Date.now();
for (let n = 0; Date.now() - start < budgetMs; n++) {
	const c1 = pick([0, 1, -1, 0x80000000, 0xff00ff00, rnd()]);
	const flip = rnd() % 3 === 0 ? 1 << (rnd() % 32) : 0;
	const c2 = c1 ^ flip;
	const src = make(stage(c1), stage(c2));
	let bytes: Uint8Array;
	try {
		bytes = buildWat(src);
	} catch {
		continue;
	}
	built++;
	const v = runLoop(bytes);
	if (!v.accepted) {
		if (!flip) refusedEqual++;
		continue;
	}
	accepted++;
	if (n % 4 === 0 || flip) {
		const t = truth(bytes);
		if (!t.composes) {
			wrong++;
			log.push(`${t.firstFailure}\n${src}`);
		}
	} else if (flip) {
		wrong++;
	}
}
writeFileSync(
	`${dir}/fuzz3.json`,
	JSON.stringify(
		{ seed: `0x${SEED.toString(16)}`, budgetMs, built, accepted, wrong, refusedEqual, log },
		null,
		1
	),
	{ flag: 'wx' }
);
console.log({ built, accepted, wrong, refusedEqual });
if (log.length) console.log(log[0]);
