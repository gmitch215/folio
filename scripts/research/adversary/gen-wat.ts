import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../../src/certify.ts';
import { buildWat, mulberry, sha256, workDir } from './lib.ts';

// usage: node gen-wat.ts [DIR]; random, adversarial and mutant WAT modules under DIR/modules
// locals: 0 state, 1 pointer, 2 length, 3 byte, 4-7 aux
const root = workDir(process.argv[2]);
const S = '(local.get 0)';
const B = '(local.get 3)';
const STEP = (E: string) =>
	`(local.set 3 (i32.load8_u (local.get 1))) (local.set 0 ${E}) (local.set 1 (i32.add (local.get 1) (i32.const 1)))`;
const FUNC = (body: string, extra = '') =>
	`${extra}(func $update (export "update") (param i32 i32 i32) (result i32) (local i32 i32 i32 i32 i32) ${body} (local.get 0))`;
const FUNC64 = (body: string, extra = '') =>
	`${extra}(func $update (export "update") (param i64 i32 i32) (result i64) (local i32 i32 i32 i32 i32) ${body} (local.get 0))`;

const shape = {
	tail: (E: string) =>
		`(block $done (br_if $done (i32.eqz (local.get 2))) (loop $again ${STEP(E)} (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`,
	head: (E: string) =>
		`(block $done (loop $again (br_if $done (i32.eqz (local.get 2))) ${STEP(E)} (local.set 2 (i32.add (local.get 2) (i32.const -1))) (br $again)))`,
	end: (E: string) =>
		`(local.set 4 (i32.add (local.get 1) (local.get 2))) (block $done (br_if $done (i32.eq (local.get 1) (local.get 4))) (loop $again ${STEP(E)} (br_if $again (i32.ne (local.get 1) (local.get 4)))))`,
	unroll: (E: string, k: number) =>
		`(block $tail (loop $blk (br_if $tail (i32.lt_u (local.get 2) (i32.const ${k}))) ${Array(k).fill(STEP(E)).join(' ')} (local.set 2 (i32.sub (local.get 2) (i32.const ${k}))) (br $blk))) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $one ${STEP(E)} (br_if $one (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`,
	rev: (E: string) =>
		`(local.set 4 (local.get 2)) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (local.set 3 (i32.load8_u (i32.add (local.get 1) (i32.add (local.get 4) (i32.const -1))))) (local.set 0 ${E}) (br_if $again (local.tee 4 (i32.add (local.get 4) (i32.const -1))))))`
};
const SHAPES = ['tail', 'head', 'end', 'unroll2', 'unroll3', 'rev'] as const;
const shaped = (kind: (typeof SHAPES)[number], E: string) =>
	kind === 'unroll2'
		? shape.unroll(E, 2)
		: kind === 'unroll3'
			? shape.unroll(E, 3)
			: shape[kind](E);

const konst = (r: () => number) => `(i32.const ${Math.floor(r() * 2 ** 32) | 0})`;
const shiftc = (r: () => number) => `(i32.const ${1 + Math.floor(r() * 31)})`;
function randExpr(r: () => number, depth: number): string {
	if (depth === 0 || r() < 0.25) {
		const q = r();
		return q < 0.45 ? S : q < 0.9 ? B : konst(r);
	}
	const sub = () => randExpr(r, depth - 1);
	switch (Math.floor(r() * 11)) {
		case 0:
			return `(i32.xor ${sub()} ${sub()})`;
		case 1:
			return `(i32.add ${sub()} ${sub()})`;
		case 2:
			return `(i32.sub ${sub()} ${sub()})`;
		case 3:
			return `(i32.mul ${sub()} (i32.const ${Math.floor(r() * 2 ** 30) * 2 + 1}))`;
		case 4:
			return `(i32.shl ${sub()} ${shiftc(r)})`;
		case 5:
			return `(i32.shr_u ${sub()} ${shiftc(r)})`;
		case 6:
			return `(i32.rotl ${sub()} ${shiftc(r)})`;
		case 7:
			return `(i32.and ${sub()} ${konst(r)})`;
		case 8:
			return `(i32.or ${sub()} ${konst(r)})`;
		case 9:
			return `(i32.mul ${sub()} ${sub()})`;
		default:
			return `(i32.xor ${sub()} ${konst(r)})`;
	}
}

interface Base {
	id: string;
	family: string;
	note: string;
	text: string;
}
const bases: Base[] = [];
const modules: { id: string; family: string; sha256: string; note: string; file: string }[] = [];
const seen = new Set<string>();
const dirFor = (family: string) => join(root, 'modules', family);

function emit(family: string, id: string, note: string, text: string): boolean {
	let bytes: Uint8Array;
	try {
		bytes = buildWat(text);
	} catch (e) {
		console.log('build failed', family, id, String(e).split('\n')[0]!.slice(0, 120));
		return false;
	}
	const digest = sha256(bytes);
	if (seen.has(digest)) return false;
	seen.add(digest);
	mkdirSync(dirFor(family), { recursive: true });
	const file = join(dirFor(family), `${id}.wasm`);
	writeFileSync(file, bytes);
	writeFileSync(join(dirFor(family), `${id}.wat`), text);
	modules.push({ id, family, sha256: digest, note, file: `${family}/${id}.wasm` });
	bases.push({ id, family, note, text });
	return true;
}

// #region random step expressions, each over the six shapes
const rnd = mulberry(4242);
let randomTried = 0;
for (let seed = 0; seed < 420; seed++) {
	const kind = SHAPES[seed % SHAPES.length]!;
	const depth = 2 + (seed % 3);
	let E = randExpr(rnd, depth);
	if (!E.includes('(local.get 0)')) E = `(i32.add (local.get 0) ${E})`;
	randomTried++;
	emit(
		'wat-random',
		`r${String(seed).padStart(3, '0')}-${kind}`,
		`random depth ${depth} over ${kind}`,
		FUNC(shaped(kind, E))
	);
}
// #endregion

// #region adversarial shapes
const ADD = `(i32.add (i32.mul ${S} (i32.const 31)) ${B})`;
const ADD33 = `(i32.add (i32.mul ${S} (i32.const 33)) ${B})`;
const lenBranch = (k: number, diff: boolean) =>
	FUNC(
		`(local.set 5 (local.get 2)) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (local.set 3 (i32.load8_u (local.get 1))) (if (i32.gt_u (local.get 5) (i32.const ${k})) (then (local.set 0 ${diff ? ADD33 : ADD})) (else (local.set 0 ${ADD}))) (local.set 1 (i32.add (local.get 1) (i32.const 1))) (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	);
for (const k of [16, 64, 1000, 65536, 1 << 20]) {
	emit(
		'wat-adv',
		`len-branch-same-${k}`,
		`branch on len > ${k}, same fold both arms`,
		lenBranch(k, false)
	);
	emit(
		'wat-adv',
		`len-branch-diff-${k}`,
		`branch on len > ${k}, different folds`,
		lenBranch(k, true)
	);
}
for (const k of [5, 100, 4096, 1 << 20]) {
	emit(
		'wat-adv',
		`trigger-index-${k}`,
		`state flip when the loop index equals ${k}`,
		FUNC(
			`(block $done (br_if $done (i32.eqz (local.get 2))) (loop $again ${STEP(ADD)} (if (i32.eq (local.get 6) (i32.const ${k})) (then (local.set 0 (i32.xor (local.get 0) (i32.const 1))))) (local.set 6 (i32.add (local.get 6) (i32.const 1))) (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
		)
	);
}
for (const [variant, alt] of [
	['same', ADD],
	['diff', ADD33]
] as const) {
	emit(
		'wat-adv',
		`mod4-select-${variant}`,
		`select on len mod 4, ${variant} arms`,
		FUNC(
			`(local.set 5 (local.get 2)) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (local.set 3 (i32.load8_u (local.get 1))) (if (i32.eq (i32.and (local.get 5) (i32.const 3)) (i32.const 2)) (then (local.set 0 ${alt})) (else (local.set 0 ${ADD}))) (local.set 1 (i32.add (local.get 1) (i32.const 1))) (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
		)
	);
}
emit(
	'wat-adv',
	'store-after-loop-large',
	'store to memory when len > 100000, after a valid fold',
	FUNC(
		`(local.set 5 (local.get 2)) ${shape.tail(ADD)} (if (i32.gt_u (local.get 5) (i32.const 100000)) (then (i32.store8 (i32.const 2097152) (i32.const 9))))`
	)
);
emit(
	'wat-adv',
	'unreachable-rare-len',
	'trap at one length after a valid fold',
	FUNC(
		`(local.set 5 (local.get 2)) ${shape.tail(ADD)} (if (i32.eq (local.get 5) (i32.const 123456)) (then unreachable))`
	)
);
emit(
	'wat-adv',
	'zero-length-special',
	'returns a constant for len 0 only',
	FUNC(`(if (i32.eqz (local.get 2)) (then (return (i32.const 305419896)))) ${shape.tail(ADD)}`)
);
emit(
	'wat-adv',
	'signed-length-branch',
	'branch on signed length; refusal expected',
	FUNC(
		`(if (i32.lt_s (local.get 2) (i32.const 0)) (then (local.set 0 (i32.const 7)))) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'global-counter',
	'mutable global changes the fold on every call',
	`(global $g (mut i32) (i32.const 0)) ${FUNC(`(global.set $g (i32.add (global.get $g) (i32.const 1))) ${shape.tail(`(i32.xor ${ADD} (global.get $g))`)}`)}`
);
emit(
	'wat-adv',
	'indirect-call-step',
	'step through call_indirect',
	`(type $t (func (param i32 i32) (result i32))) (table 1 funcref) (elem (i32.const 0) $step) (func $step (type $t) (param i32 i32) (result i32) (i32.add (i32.mul (local.get 0) (i32.const 31)) (local.get 1))) ${FUNC(shape.tail(`(call_indirect (type $t) ${S} ${B} (i32.const 0))`))}`
);
for (const depth of [4, 9]) {
	let defs = '';
	for (let k = 0; k < depth; k++)
		defs += `(func $s${k} (param i32 i32) (result i32) (call $s${k + 1} (local.get 0) (local.get 1))) `;
	defs += `(func $s${depth} (param i32 i32) (result i32) (i32.add (i32.mul (local.get 0) (i32.const 31)) (local.get 1))) `;
	emit(
		'wat-adv',
		`call-depth-${depth}`,
		`nested internal calls, depth ${depth}`,
		defs + FUNC(shape.tail(`(call $s0 ${S} ${B})`))
	);
}
emit(
	'wat-adv',
	'i64-affine-mul',
	'i64 state, multiply and add the byte',
	FUNC64(
		shape.tail(
			'(i64.add (i64.mul (local.get 0) (i64.const 0x9E3779B97F4A7C15)) (i64.extend_i32_u (local.get 3)))'
		)
	)
);
emit(
	'wat-adv',
	'i64-rot-xor',
	'i64 rotation and xor with the byte',
	FUNC64(
		shape.tail(
			'(i64.xor (i64.rotl (local.get 0) (i64.const 13)) (i64.extend_i32_u (local.get 3)))'
		)
	)
);
emit(
	'wat-adv',
	'i64-sext-mix',
	'i64 state mixed with a sign-extended byte through multiply',
	FUNC64(
		shape.tail(
			'(i64.mul (i64.xor (local.get 0) (i64.extend_i32_s (i32.extend8_s (local.get 3)))) (i64.const 0x100000001B3))'
		)
	)
);
emit(
	'wat-adv',
	'sext-xor',
	'sign-extended byte xor',
	FUNC(shape.tail(`(i32.xor ${S} (i32.extend8_s ${B}))`))
);
emit(
	'wat-adv',
	'clz-atom',
	'xor with clz of the byte',
	FUNC(shape.tail(`(i32.xor ${S} (i32.clz ${B}))`))
);
emit(
	'wat-adv',
	'popcnt-parity',
	'xor with the parity of the byte',
	FUNC(shape.tail(`(i32.xor ${S} (i32.and (i32.popcnt ${B}) (i32.const 1)))`))
);
emit(
	'wat-adv',
	'popcnt-state',
	'state plus its own popcount',
	FUNC(shape.tail(`(i32.add ${S} (i32.popcnt ${S}))`))
);
emit(
	'wat-adv',
	'mixed-xor-add',
	'xor then add a constant; not affine over either ring',
	FUNC(shape.tail(`(i32.add (i32.xor ${S} ${B}) (i32.const 0x9e3779b9))`))
);
{
	const table = Array.from({ length: 256 }, (_, i) => (i === 200 ? 201 : i));
	const esc = table.map((v) => `\\${v.toString(16).padStart(2, '0')}`).join('');
	emit(
		'wat-adv',
		'almost-linear-table',
		'xor with a table that is linear except at one entry',
		`(data (i32.const 1572864) "${esc}") ${FUNC(shape.tail(`(i32.xor ${S} (i32.load8_u (i32.add (i32.const 1572864) ${B})))`))}`
	);
	const linear = Array.from({ length: 256 }, (_, i) => i);
	const linesc = linear.map((v) => `\\${v.toString(16).padStart(2, '0')}`).join('');
	emit(
		'wat-adv',
		'linear-table',
		'xor with a linear table read at the byte',
		`(data (i32.const 1572864) "${linesc}") ${FUNC(shape.tail(`(i32.xor ${S} (i32.load8_u (i32.add (i32.const 1572864) ${B})))`))}`
	);
}
{
	const lazy = (flagStore: string) =>
		FUNC(
			`(if (i32.eqz (i32.load8_u (i32.const 1048320))) (then (i32.store8 (i32.const 1048320) (i32.const 1)) ${flagStore})) ${shape.tail(`(i32.add (i32.mul ${S} (i32.load8_u (i32.const 1048336))) ${B})`)}`
		);
	emit(
		'wat-adv',
		'lazy-table-valid',
		'table built on the first call, same value after',
		lazy('(i32.store8 (i32.const 1048336) (i32.const 3))')
	);
	emit(
		'wat-adv',
		'lazy-table-else-writes',
		'first call writes 3, a later call writes 5',
		FUNC(
			`(if (i32.eqz (i32.load8_u (i32.const 1048320))) (then (i32.store8 (i32.const 1048320) (i32.const 1)) (i32.store8 (i32.const 1048336) (i32.const 3))) (else (i32.store8 (i32.const 1048336) (i32.const 5)))) ${shape.tail(`(i32.add (i32.mul ${S} (i32.load8_u (i32.const 1048336))) ${B})`)}`
		)
	);
}
{
	// a data segment written twice: the later segment is the one memory holds
	const lo = `(data (i32.const 589824) "\\01") (data (i32.const 589824) "\\03")`;
	const add = `(data (i32.const 589824) "\\02") (data (i32.const 589824) "\\07")`;
	emit(
		'wat-adv',
		'overlap-seg-mul',
		'multiplier from a byte written by two data segments',
		`${lo} ${FUNC(shape.tail(`(i32.add (i32.mul ${S} (i32.load8_u (i32.const 589824))) ${B})`))}`
	);
	emit(
		'wat-adv',
		'overlap-seg-xor',
		'xor with a byte written by two data segments',
		`${add} ${FUNC(shape.tail(`(i32.xor (i32.add ${S} ${B}) (i32.load8_u (i32.const 589824)))`))}`
	);
	emit(
		'wat-adv',
		'overlap-seg-single',
		'control: one data segment, same final byte',
		`(data (i32.const 589824) "\\03") ${FUNC(shape.tail(`(i32.add (i32.mul ${S} (i32.load8_u (i32.const 589824))) ${B})`))}`
	);
}
emit(
	'wat-adv',
	'overrun-one-block',
	'loop count is len/16 + 1 blocks of 16 bytes',
	FUNC(
		`(local.set 5 (i32.add (i32.shr_u (local.get 2) (i32.const 4)) (i32.const 1))) (block $done (loop $again (br_if $done (i32.eqz (local.get 5))) ${Array(16).fill(STEP(ADD)).join(' ')} (local.set 5 (i32.add (local.get 5) (i32.const -1))) (br $again)))`
	)
);
emit(
	'wat-adv',
	'counter-starts-at-3',
	'loop counter starts at 3 and stops at len + 3',
	FUNC(
		`(block $done (br_if $done (i32.eqz (local.get 2))) (local.set 6 (i32.const 3)) (loop $again ${STEP(ADD)} (local.set 6 (i32.add (local.get 6) (i32.const 1))) (br_if $again (i32.ne (local.get 6) (i32.add (local.get 2) (i32.const 3))))))`
	)
);
emit(
	'wat-adv',
	'two-passes-same-bytes',
	'second pass reads the same bytes again',
	FUNC(
		`(local.set 6 (local.get 2)) (local.set 7 (local.get 1)) ${shape.tail(ADD)} (local.set 1 (local.get 7)) (local.set 2 (local.get 6)) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'two-passes-split',
	'two loops over the two halves of the input',
	FUNC(
		`(local.set 6 (local.get 2)) (local.set 5 (i32.shr_u (local.get 2) (i32.const 1))) (block $a (br_if $a (i32.eqz (local.get 5))) (loop $la ${STEP(ADD)} (br_if $la (local.tee 5 (i32.add (local.get 5) (i32.const -1)))))) (local.set 2 (i32.sub (local.get 6) (i32.shr_u (local.get 6) (i32.const 1)))) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'postcondition-odd-len',
	'xor 1 when the length is odd',
	FUNC(
		`(local.set 5 (local.get 2)) ${shape.tail(ADD)} (if (i32.and (local.get 5) (i32.const 1)) (then (local.set 0 (i32.xor (local.get 0) (i32.const 1)))))`
	)
);
emit(
	'wat-adv',
	'length-folded-in',
	'adds the length to the state before the loop',
	FUNC(`(local.set 0 (i32.add (local.get 0) (local.get 2))) ${shape.tail(ADD)}`)
);
emit(
	'wat-adv',
	'select-on-state',
	'select between two folds on the state',
	FUNC(
		`(local.set 5 (local.get 2)) ${shape.tail(`(select (i32.add (i32.mul ${S} (i32.const 31)) ${B}) (i32.add (i32.mul ${S} (i32.const 33)) ${B}) (i32.and ${S} (i32.const 1)))`)}`
	)
);
emit(
	'wat-adv',
	'pointer-align-branch',
	'two arms that are the same fold, chosen by pointer alignment',
	FUNC(`${shape.tail(`(select ${ADD} ${ADD} (i32.and (local.get 1) (i32.const 3)))`)}`)
);
emit(
	'wat-adv',
	'pointer-align-if',
	'two arms that are the same fold, chosen by an if on the pointer',
	FUNC(
		`(block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (local.set 3 (i32.load8_u (local.get 1))) (if (i32.and (local.get 1) (i32.const 3)) (then (local.set 0 ${ADD})) (else (local.set 0 ${ADD}))) (local.set 1 (i32.add (local.get 1) (i32.const 1))) (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	)
);
emit(
	'wat-adv',
	'count-by-threshold-large',
	'drops the last byte once len reaches 2^20',
	FUNC(
		`(local.set 5 (local.get 2)) (if (i32.ge_u (local.get 2) (i32.const 1048576)) (then (local.set 2 (i32.sub (local.get 2) (i32.const 1))))) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'unroll4-tail-bug',
	'four byte steps per iteration with a tail that repeats the last byte',
	FUNC(
		`(block $tail (loop $blk (br_if $tail (i32.lt_u (local.get 2) (i32.const 4))) ${Array(4).fill(STEP(ADD)).join(' ')} (local.set 2 (i32.sub (local.get 2) (i32.const 4))) (br $blk))) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $one (local.set 3 (i32.load8_u (i32.sub (local.get 1) (i32.const 1)))) (local.set 0 ${ADD}) (br_if $one (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	)
);
emit(
	'wat-adv',
	'word-load-tail',
	'reads a 32-bit word with a byte tail; word fold is not the byte fold',
	FUNC(
		`(block $tail (loop $blk (br_if $tail (i32.lt_u (local.get 2) (i32.const 4))) (local.set 0 (i32.add (i32.mul (local.get 0) (i32.const 31)) (i32.load (local.get 1)))) (local.set 1 (i32.add (local.get 1) (i32.const 4))) (local.set 2 (i32.sub (local.get 2) (i32.const 4))) (br $blk))) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'word-load-fold',
	'reads a 32-bit word and folds its bytes one at a time, four to a block',
	FUNC(
		`(block $tail (loop $blk (br_if $tail (i32.lt_u (local.get 2) (i32.const 4))) (local.set 6 (i32.load (local.get 1))) ${[0, 8, 16, 24].map((s) => `(local.set 0 (i32.add (i32.mul (local.get 0) (i32.const 31)) (i32.and (i32.shr_u (local.get 6) (i32.const ${s})) (i32.const 255))))`).join(' ')} (local.set 1 (i32.add (local.get 1) (i32.const 4))) (local.set 2 (i32.sub (local.get 2) (i32.const 4))) (br $blk))) ${shape.tail(ADD)}`
	)
);
emit(
	'wat-adv',
	'window-loads-two-bytes',
	'reads two bytes per step, one of them the next byte',
	FUNC(
		`(block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (local.set 0 (i32.add (i32.mul (local.get 0) (i32.const 31)) (i32.load8_u (local.get 1)))) (local.set 0 (i32.add (local.get 0) (i32.load8_u (i32.add (local.get 1) (i32.const 1))))) (local.set 1 (i32.add (local.get 1) (i32.const 1))) (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	)
);
emit(
	'wat-adv',
	'reads-prev-byte',
	'a byte read from one before the pointer on the first step',
	FUNC(`(local.set 3 (i32.load8_u (i32.add (local.get 1) (i32.const -1)))) ${shape.tail(ADD)}`)
);
emit(
	'wat-adv',
	'prefix-stores-fixed-cell',
	'stores a constant into memory before the loop, read in the loop',
	FUNC(
		`(i32.store8 (i32.const 1048300) (i32.const 77)) (block $done (br_if $done (i32.eqz (local.get 2))) (loop $again ${STEP(`(i32.add (i32.mul ${S} (i32.const 31)) (i32.add ${B} (i32.load8_u (i32.const 1048300))))`)} (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	)
);
emit(
	'wat-adv',
	'static-counter-in-loop',
	'counter in memory added to the fold; refusal and warm mismatch both expected',
	FUNC(
		`(block $done (br_if $done (i32.eqz (local.get 2))) (loop $again (i32.store8 (i32.const 1048304) (i32.add (i32.load8_u (i32.const 1048304)) (i32.const 1))) ${STEP(`(i32.add (i32.mul ${S} (i32.const 31)) (i32.add ${B} (i32.load8_u (i32.const 1048304))))`)} (br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))`
	)
);
// #endregion

// #region mutants: one constant, comparison or arithmetic op changed in an accepted base
const accepted = bases.filter((b) => {
	try {
		return certifyStream(buildWat(b.text), 'update').kind === 'certificate';
	} catch {
		return false;
	}
});
const mrnd = mulberry(990011);
let mutants = 0;

function swapSites(text: string): [number, number, string][] {
	const out: [number, number, string][] = [];
	const table: [string, string][] = [
		['(i32.add ', '(i32.xor '],
		['(i32.xor ', '(i32.add '],
		['(i32.lt_u ', '(i32.le_u '],
		['(i32.ne ', '(i32.eq '],
		['(i32.shr_u ', '(i32.shr_s '],
		['(i32.mul ', '(i32.add ']
	];
	for (const [from, to] of table) {
		let at = text.indexOf(from);
		while (at >= 0) {
			out.push([at, from.length, to]);
			at = text.indexOf(from, at + 1);
		}
	}
	return out;
}

for (const base of accepted) {
	const consts = [...base.text.matchAll(/\(i32\.const (-?\d+)\)/g)];
	const ops = swapSites(base.text);
	for (let m = 0; m < 4; m++) {
		let text: string;
		let what: string;
		if (m < 2 && consts.length) {
			const hit = consts[Math.floor(mrnd() * consts.length)]!;
			const value = Number(hit[1]);
			const nv = m === 0 ? value + 1 : value ^ (1 << Math.floor(mrnd() * 16));
			text =
				base.text.slice(0, hit.index!) +
				`(i32.const ${nv | 0})` +
				base.text.slice(hit.index! + hit[0].length);
			what = `const ${value} -> ${nv | 0}`;
		} else {
			const site = ops[Math.floor(mrnd() * ops.length)];
			if (!site) continue;
			const [pos, len, repl] = site;
			text = base.text.slice(0, pos) + repl + base.text.slice(pos + len);
			what = `op ${base.text.slice(pos, pos + len)} -> ${repl}`;
		}
		if (text === base.text) continue;
		if (emit('wat-mutant', `${base.id}-m${m}`, `${base.note}; mutated: ${what}`, text))
			mutants++;
	}
}
// #endregion

const counts: Record<string, number> = {};
for (const m of modules) counts[m.family] = (counts[m.family] ?? 0) + 1;
writeFileSync(join(root, 'modules/index-wat.json'), JSON.stringify(modules, null, 1));
console.log(
	'random tried',
	randomTried,
	'accepted bases',
	accepted.length,
	'mutants',
	mutants,
	counts
);
