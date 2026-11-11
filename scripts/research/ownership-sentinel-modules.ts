import { allocModuleOf, ARENA_BYTES, type AllocBase } from './ownership-alloc-modules.ts';
import { SHIM_FUNCS } from './ownership-extent-modules.ts';

const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const GUARD = (limit: number, body: string, min = 0) =>
	`(block $out (br_if $out (i32.gt_u (local.get $len) (i32.const ${limit})))${min ? ` (br_if $out (i32.lt_u (local.get $len) (i32.const ${min})))` : ''} ${body})`;

// the input is copied into a buffer of len + pad bytes and fill is written over zero bytes at the end, as
// yyjson_read_opts does; the scan starts at the buffer start
const buffer = (
	{
		pad = 4,
		fill = 0,
		zero = 4,
		at = '(i32.add (local.get $a) (local.get $len))',
		between = '',
		limit = 400,
		min = 0,
		start = '(local.get $a)'
	},
	scan: string
) => [
	SET,
	GUARD(
		limit,
		`(local.set $a (call $malloc (i32.add (local.get $len) (i32.const ${pad}))))
		(if (local.get $a) (then
			(drop (call $memcpy (local.get $a) (local.get $p) (local.get $len)))
			(local.set $d ${at})
			(drop (call $memset (local.get $d) (i32.const ${fill}) (i32.const ${zero})))
			${between}
			(local.set $b ${start})
			${scan}
			(i32.store (local.get $slot) (i32.sub (local.get $b) (local.get $a)))))`,
		min
	)
];

const ADVANCE = (n: number) => `(local.set $b (i32.add (local.get $b) (i32.const ${n})))`;
// each loop runs while the byte it reads satisfies the test and stops at the zero padding
const loopOf = (exit: string, body: string, step = 1) =>
	`(block $x (loop $s (br_if $x ${exit}) ${body} ${ADVANCE(step)} (br $s)))`;
const READ = '(i32.load8_u (local.get $b))';
const SPACE = loopOf(`(i32.ne ${READ} (i32.const 32))`, '');
const NUL = loopOf(`(i32.eqz ${READ})`, '');
const STEP = (n: number) => loopOf(`(i32.eqz ${READ})`, '', n);
const INPLACE = loopOf(
	`(i32.eqz ${READ})`,
	'(i32.store8 (local.get $b) (i32.add (i32.load8_u (local.get $b)) (i32.const 1)))'
);
const AHEAD = loopOf(`(i32.eqz ${READ})`, '(i32.store8 offset=1 (local.get $b) (local.get $sum))');
// the byte after a nonzero byte is read without a test of its own
const PEEK = loopOf(
	`(i32.eqz ${READ})`,
	'(i32.store offset=4 (local.get $slot) (i32.load8_u offset=1 (local.get $b)))'
);

const TABLE_AT = 1024;
// every byte but 0 has the space bit, unless zero is set too
const tableData = (zero: boolean) =>
	`(data (i32.const ${TABLE_AT}) "${Array.from({ length: 256 }, (_, i) => `\\${(i === 0 && !zero ? 0 : 4).toString(16).padStart(2, '0')}`).join('')}")`;
const TABLE = loopOf(
	`(i32.eqz (i32.and (i32.load8_u offset=${TABLE_AT} (local.tee $c (i32.load8_u (local.get $b)))) (i32.const 4)))`,
	''
);
const OFFSET = loopOf(
	'(i32.eqz (i32.load8_u offset=1 (local.get $b)))',
	'(i32.store offset=4 (local.get $slot) (i32.load8_u offset=5 (local.get $b)))'
);

// scans that stop at the zero padding; each is a hand-built shape of the first scan loop of yyjson_read_opts
export const SENTINEL_BASES: Record<string, AllocBase> = {
	space: { extra: SHIM_FUNCS, statements: buffer({}, SPACE) },
	nul: { extra: SHIM_FUNCS, statements: buffer({}, NUL) },
	short: { extra: SHIM_FUNCS, statements: buffer({ zero: 1 }, NUL) },
	step2: { extra: SHIM_FUNCS, statements: buffer({}, STEP(2)) },
	step2short: { extra: SHIM_FUNCS, statements: buffer({ zero: 1 }, STEP(2)) },
	step5: { extra: SHIM_FUNCS, statements: buffer({}, STEP(5)) },
	inplace: { extra: SHIM_FUNCS, statements: buffer({}, INPLACE) },
	ahead: { extra: SHIM_FUNCS, statements: buffer({}, AHEAD) },
	peek: { extra: SHIM_FUNCS, statements: buffer({}, PEEK) },
	nopad: { extra: SHIM_FUNCS, statements: buffer({ pad: 0, zero: 0 }, NUL) },
	nonzero: { extra: SHIM_FUNCS, statements: buffer({ fill: 1 }, NUL) },
	early: {
		extra: SHIM_FUNCS,
		statements: buffer(
			{ at: '(i32.sub (i32.add (local.get $a) (local.get $len)) (i32.const 1))' },
			NUL
		)
	},
	overwrite: {
		extra: SHIM_FUNCS,
		statements: buffer({ between: '(i32.store8 (local.get $d) (i32.const 1))' }, NUL)
	},
	overcopy: {
		extra: SHIM_FUNCS,
		statements: buffer(
			{ between: '(drop (call $memcpy (local.get $d) (local.get $p) (i32.const 2)))' },
			NUL
		)
	},
	farstore: {
		extra: SHIM_FUNCS,
		statements: buffer({ between: '(i32.store8 (local.get $a) (i32.const 1))' }, NUL)
	},
	// a pointer that is not at or below the end of the buffer
	beyond: {
		extra: SHIM_FUNCS,
		statements: buffer(
			{ between: '(local.set $a (i32.add (local.get $a) (i32.const 40)))' },
			NUL
		)
	},
	// the test is a table lookup, as in yyjson's char_is_space: table[byte] & 4
	tabnul: { extra: `${SHIM_FUNCS}\n${tableData(false)}`, statements: buffer({}, TABLE) },
	tabzero: { extra: `${SHIM_FUNCS}\n${tableData(true)}`, statements: buffer({}, TABLE) },
	// the byte read ahead of the cursor decides the loop, and the cursor reads further ahead
	// the table was written to before the scan, so its entry for byte 0 is not known
	tabstore: {
		extra: `${SHIM_FUNCS}\n${tableData(false)}`,
		statements: buffer(
			{ between: `(i32.store8 (i32.const ${TABLE_AT}) (local.get $sum))` },
			TABLE
		)
	},
	// the scan starts at the end of the first padding after a second padding was made below it and the first byte
	// of the first was overwritten, so only the second is known
	stale: {
		extra: SHIM_FUNCS,
		statements: buffer(
			{
				min: 8,
				start: '(local.get $d)',
				between:
					'(drop (call $memset (local.get $a) (i32.const 0) (i32.const 4))) (i32.store8 (local.get $d) (i32.const 1))'
			},
			NUL
		)
	},
	// the loop continues while the byte is zero, which says nothing about being below the padding
	zeroscan: {
		extra: SHIM_FUNCS,
		statements: buffer({}, loopOf(`(i32.ne ${READ} (i32.const 0))`, ''))
	},
	offsetscan: { extra: SHIM_FUNCS, statements: buffer({ limit: 492 }, OFFSET) },
	// a write numerically below or above the padding keeps it
	belownum: {
		extra: SHIM_FUNCS,
		statements: buffer({ min: 8, between: '(i32.store8 (local.get $a) (i32.const 1))' }, NUL)
	},
	above: {
		extra: SHIM_FUNCS,
		statements: buffer(
			{ limit: 16, min: 8, between: '(i32.store8 offset=12 (local.get $d) (i32.const 1))' },
			NUL
		)
	}
};

export const sentinelModule = (name: string, statements?: string[]) =>
	allocModuleOf(SENTINEL_BASES[name]!, statements);
