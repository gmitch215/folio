import { allocModuleOf, type AllocBase } from './ownership-alloc-modules.ts';
import { buffer, SHIM_FUNCS } from './ownership-yyjson-modules.ts';

// a loop whose head is a br_table on a state local: state 1 copies four bytes to the destination after testing
// them nonzero, so it needs the destination to trail the source; the else arm of a copy pushes the destination
// ahead of the source and goes to a state that puts it back, as the state machine of yyjson does
const TEST4 = [0, 1, 2, 3]
	.map((i) => `(br_if $x (i32.eqz (i32.load8_u offset=${i} (local.get $b))))`)
	.join(' ');
const SET = (local: string, n: number) => `(local.set $${local} (i32.const ${n}))`;
const STEPS = (local: string, n: number) =>
	`(local.set $${local} (i32.add (local.get $${local}) (i32.const ${n})))`;
const RESET = '(local.set $acc (local.get $b))';
const ALL = ['$s0', '$s1', '$s0', '$s0', '$s0', '$s0'];

// the else arm sets one of `values`, chosen by a bit of the input length, and goes back to the head
const AWAY = (values: string[]) =>
	values.reduceRight(
		(rest, value, i) =>
			i === values.length - 1
				? `${value} (br $s)`
				: `(if (i32.and (local.get $len) (i32.const ${1 << i})) (then ${value} (br $s)) (else ${rest}))`,
		''
	);

interface Shape {
	// index i of the br_table goes to the state at table[i]; the default is state 1
	table?: string[];
	// what state 0 does after its reset
	state0?: string;
	// what the else arm of the copy sets for the dispatch local
	away?: string[];
	// run at the start of state 1
	pre?: string;
	// the reset of state 0
	reset?: string;
	// the step of the destination in the else arm
	push?: number;
	// what runs before the loop, in the block that holds the loop
	entry?: string;
}

// two paths that reach the loop with different states, merged at the end of a block
const ENTRY = (second: string) => `(block $e
	(if (local.get $sum) (then ${RESET} ${SET('n', 1)} (br $e)))
	(local.set $acc (i32.add (local.get $b) (i32.const 8)))
	${second})`;

export const DISPATCH = ({
	table = ['$s0', '$s1'],
	state0 = `${SET('n', 1)} (br $s)`,
	away = [SET('n', 0)],
	pre = '',
	reset = RESET,
	push = 8,
	entry = `${RESET} ${SET('n', 1)}`
}: Shape = {}) => `
	(block $x
		${entry}
		(loop $s
		(block $s1
			(block $s0 (br_table ${table.join(' ')} $s1 (local.get $n)))
			${reset}
			${state0})
		${pre}
		${TEST4}
		(i32.store (local.get $acc) (i32.load (local.get $b)))
		(if (local.get $sum)
			(then ${STEPS('b', 4)} ${STEPS('acc', 1)} (br $s))
			(else ${STEPS('b', 3)} ${STEPS('acc', push)} ${AWAY(away)}))))`;

export const plain = (text: string): AllocBase => ({
	extra: SHIM_FUNCS,
	statements: buffer('', text)
});

const setN = (n: number) => SET('n', n);

// each base certifies unless the test lists it as refused
export const DISPATCH_BASES: Record<string, AllocBase> = {
	dispatch: plain(DISPATCH()),
	dispatch3: plain(DISPATCH({ table: ALL, away: [setN(0), setN(2)] })),
	dispatch4: plain(DISPATCH({ table: ALL, away: [setN(0), setN(2), setN(3)] })),
	dispatchfall: plain(DISPATCH({ state0: '' })),
	dispatchdata: plain(
		DISPATCH({ pre: '(local.set $n (i32.load8_u (local.get $b)))', away: [''] })
	),
	dispatchfromdata: plain(
		DISPATCH({ away: ['(local.set $n (i32.and (local.get $len) (i32.const 1)))'] })
	),
	dispatchoutside: plain(DISPATCH({ away: [setN(2)] })),
	dispatch5: plain(DISPATCH({ table: ALL, away: [setN(0), setN(2), setN(3), setN(4)] })),
	dispatch6: plain(DISPATCH({ table: ALL, away: [setN(0), setN(2), setN(3), setN(4), setN(5)] })),
	dispatchnoreset: plain(DISPATCH({ reset: '' })),
	dispatchpast: plain(
		DISPATCH({ reset: '(local.set $acc (i32.add (local.get $b) (i32.const 1)))' })
	),
	dispatchfallbad: plain(DISPATCH({ reset: '', state0: '' })),
	dispatchentry: plain(DISPATCH({ entry: ENTRY(setN(0)) })),
	dispatchentrybad: plain(DISPATCH({ entry: ENTRY(setN(1)) })),
	dispatchentrydata: plain(
		DISPATCH({ entry: ENTRY('(local.set $n (i32.and (local.get $len) (i32.const 1)))') })
	)
};

export const dispatchModule = (name: string, statements?: string[]) =>
	allocModuleOf(DISPATCH_BASES[name]!, statements);
