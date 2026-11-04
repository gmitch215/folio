import type { Spec } from './lib.ts';

const L = (n: string) => `(local.get $${n})`;
const c = (v: number | string) => `(i32.const ${v})`;
const A = `(i32.add ${L('p')} ${L('i')})`;
const A1 = `(i32.add ${A} ${c(1)})`;
const ld = (a = A, off = 0) => `(i32.load8_u${off ? ` offset=${off}` : ''} ${a})`;
const st = (a: string, v: string, off = 0) =>
	`(i32.store8${off ? ` offset=${off}` : ''} ${a} ${v})`;
const xor = (a: string, b: string) => `(i32.xor ${a} ${b})`;
const add = (a: string, b: string) => `(i32.add ${a} ${b})`;
const mul = (a: string, b: string) => `(i32.mul ${a} ${b})`;
const set = (n: string, v: string) => `(local.set $${n} ${v})`;
const shr = (a: string, k: number) => `(i32.shr_u ${a} ${c(k)})`;

const out: Spec[] = [];
const push = (family: string, name: string, src: string, expect?: { p: number }) =>
	out.push({ id: `${family}/${name}`, family, kind: 'wat', src, expect, note: name });

// #region residue kernels in WAT

interface Adler {
	P1: number | string;
	P2: number | string;
	init1: string;
	init2: string;
	step1: string;
	step2: string;
	pack: string;
	shape: 'head' | 'tail' | 'two';
	extraLocals: string;
	pre: string;
	post: string;
}
const adlerDefault = (): Adler => ({
	P1: 65521,
	P2: 65521,
	init1: `(i32.and ${L('s')} ${c(65535)})`,
	init2: shr(L('s'), 16),
	step1: '',
	step2: '',
	pack: '',
	shape: 'head',
	extraLocals: '',
	pre: '',
	post: ''
});
function adlerWat(o: Partial<Adler>): string {
	const a = { ...adlerDefault(), ...o };
	const b = ld();
	const step1 = a.step1 || `(i32.rem_u ${add(L('s1'), b)} ${c(a.P1)})`;
	const step2 = a.step2 || `(i32.rem_u ${add(L('s2'), L('s1'))} ${c(a.P2)})`;
	const pack = a.pack || `(i32.or (i32.shl ${L('s2')} ${c(16)}) ${L('s1')})`;
	const body = `${set('s1', step1)} ${set('s2', step2)}`;
	const body2 = `${body} ${set('i', add(L('i'), c(1)))}`;
	let loop: string;
	if (a.shape === 'head')
		loop = `(block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${body2} (br $l)))`;
	else if (a.shape === 'tail')
		loop = `(if (i32.ne ${L('n')} ${c(0)}) (then (loop $l ${body2} (br_if $l (i32.lt_u ${L('i')} ${L('n')})))))`;
	else {
		// two bytes per iteration with a 16 bit load, then a one byte tail
		const b0 = `(i32.and (i32.load16_u ${A}) ${c(255)})`;
		const b1 = shr(`(i32.load16_u ${A})`, 8);
		const s1a = `(i32.rem_u ${add(L('s1'), b0)} ${c(a.P1)})`;
		const s2a = `(i32.rem_u ${add(L('s2'), L('s1'))} ${c(a.P2)})`;
		const s1b = `(i32.rem_u ${add(L('s1'), b1)} ${c(a.P1)})`;
		loop = `(block $d1 (loop $l1 (br_if $d1 (i32.gt_u ${add(L('i'), c(2))} ${L('n')}))
 ${set('s1', s1a)} ${set('s2', s2a)} ${set('s1', s1b)} ${set('s2', s2a)}
 ${set('i', add(L('i'), c(2)))} (br $l1)))
 (block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${body2} (br $l)))`;
	}
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $s1 i32) (local $s2 i32) (local $i i32) ${a.extraLocals}
 ${set('s1', a.init1)} ${set('s2', a.init2)} ${a.pre}
 ${loop}
 ${a.post}
 ${pack})`;
}
const b0 = ld();
const adlerVariants: [string, Partial<Adler>, number?][] = [
	['ok', {}, 65521],
	['ok-tail', { shape: 'tail' }, 65521],
	['ok-two', { shape: 'two' }, 65521],
	['ok-P65535', { P1: 65535, P2: 65535 }, 65535],
	['ok-P251', { P1: 251, P2: 251 }, 251],
	['ok-P65536', { P1: 65536, P2: 65536 }, 65536],
	['ok-P2', { P1: 2, P2: 2 }, 2],
	['ok-P3', { P1: 3, P2: 3 }, 3],
	['mixed-P', { P1: 65521, P2: 65519 }],
	['mixed-P2', { P1: 251, P2: 65521 }],
	['no-rem1', { step1: add(L('s1'), b0) }],
	['no-rem2', { step2: add(L('s2'), L('s1')) }],
	['no-rem12', { step1: add(L('s1'), b0), step2: add(L('s2'), L('s1')) }],
	[
		'no-rem1-addpack',
		{ step1: add(L('s1'), b0), pack: add(`(i32.shl ${L('s2')} ${c(16)})`, L('s1')) }
	],
	['pack-add', { pack: add(`(i32.shl ${L('s2')} ${c(16)})`, L('s1')) }, 65521],
	['pack-or15', { pack: `(i32.or (i32.shl ${L('s2')} ${c(15)}) ${L('s1')})` }],
	['pack-or17', { pack: `(i32.or (i32.shl ${L('s2')} ${c(17)}) ${L('s1')})` }],
	['pack-xor', { pack: xor(`(i32.shl ${L('s2')} ${c(16)})`, L('s1')) }, 65521],
	['pack-sub', { pack: `(i32.sub (i32.shl ${L('s2')} ${c(16)}) ${L('s1')})` }],
	['pack-mul', { pack: add(mul(L('s2'), c(65536)), L('s1')) }, 65521],
	['pack-mul-65537', { pack: add(mul(L('s2'), c(65537)), L('s1')) }],
	['init-fffe', { init1: `(i32.and ${L('s')} ${c(65534)})` }],
	['init-1ffff', { init1: `(i32.and ${L('s')} ${c(131071)})` }],
	['init-ff', { init1: `(i32.and ${L('s')} ${c(255)})` }],
	['init-s', { init1: L('s') }],
	['init-s-rem', { init1: `(i32.rem_u ${L('s')} ${c(65521)})` }, 65521],
	['init2-shr15', { init2: shr(L('s'), 15) }],
	['init2-shr17', { init2: shr(L('s'), 17) }],
	['init2-sub', { init2: `(i32.sub ${shr(L('s'), 16)} ${c(1)})` }],
	[
		'init-swap',
		{
			init1: shr(L('s'), 16),
			init2: `(i32.and ${L('s')} ${c(65535)})`,
			pack: `(i32.or (i32.shl ${L('s1')} ${c(16)}) ${L('s2')})`
		}
	],
	['rem-wrap-mul', { step2: `(i32.rem_u ${add(mul(L('s2'), c(70000)), L('s1'))} ${c(65521)})` }],
	[
		'rem-wrap-mul-ok',
		{ step2: `(i32.rem_u ${add(mul(L('s2'), c(60000)), L('s1'))} ${c(65521)})` },
		65521
	],
	[
		'rem-wrap-shl',
		{ step1: `(i32.rem_u ${add(`(i32.shl ${L('s1')} ${c(17)})`, b0)} ${c(65521)})` }
	],
	[
		'rem-shl-ok',
		{ step1: `(i32.rem_u ${add(`(i32.shl ${L('s1')} ${c(8)})`, b0)} ${c(65521)})` },
		65521
	],
	['sub-neg', { step1: `(i32.rem_u (i32.sub ${L('s1')} ${b0}) ${c(65521)})` }],
	[
		'sub-neg-ok',
		{ step1: `(i32.rem_u ${add(`(i32.sub ${L('s1')} ${b0})`, c(65521))} ${c(65521)})` }
	],
	['sub-neg2', { step2: `(i32.rem_u (i32.sub ${L('s2')} ${L('s1')}) ${c(65521)})` }],
	[
		'sub-rev',
		{ step2: `(i32.rem_u (i32.sub ${add(L('s1'), c(65521))} ${L('s2')}) ${c(65521)})` }
	],
	['add-const-rem', { step1: `(i32.rem_u ${add(add(L('s1'), b0), c(1))} ${c(65521)})` }],
	['add-const-big', { step1: `(i32.rem_u ${add(add(L('s1'), b0), c(4294901760))} ${c(65521)})` }],
	[
		'add-const-big2',
		{ step1: `(i32.rem_u ${add(add(L('s1'), b0), c(4294836224))} ${c(65521)})` }
	],
	[
		'i64-ok',
		{
			step1: `(i32.wrap_i64 (i64.rem_u (i64.add (i64.extend_i32_u ${L('s1')}) (i64.extend_i32_u ${b0})) (i64.const 65521)))`
		},
		65521
	],
	[
		'i64-mul',
		{
			step2: `(i32.wrap_i64 (i64.rem_u (i64.add (i64.mul (i64.extend_i32_u ${L('s2')}) (i64.const 100000)) (i64.extend_i32_u ${L('s1')})) (i64.const 65521)))`
		},
		65521
	],
	[
		'i64-trunc',
		{
			step2: `(i32.wrap_i64 (i64.add (i64.mul (i64.extend_i32_u ${L('s2')}) (i64.const 100000)) (i64.extend_i32_u ${L('s1')})))`,
			pack: `(i32.or (i32.shl (i32.rem_u ${L('s2')} ${c(65521)}) ${c(16)}) ${L('s1')})`
		}
	],
	[
		'i64-big',
		{
			step2: `(i32.wrap_i64 (i64.rem_u (i64.add (i64.mul (i64.extend_i32_u ${L('s2')}) (i64.const 4294967311)) (i64.extend_i32_u ${L('s1')})) (i64.const 65521)))`
		},
		65521
	],
	[
		'i64-shl',
		{
			step1: `(i32.wrap_i64 (i64.rem_u (i64.add (i64.shl (i64.extend_i32_u ${L('s1')}) (i64.const 33)) (i64.extend_i32_u ${b0})) (i64.const 65521)))`
		}
	],
	[
		'i64-sext',
		{
			step1: `(i32.wrap_i64 (i64.rem_u (i64.add (i64.extend_i32_s ${L('s1')}) (i64.extend_i32_u ${b0})) (i64.const 65521)))`
		},
		65521
	],
	['rems', { step1: `(i32.rem_s ${add(L('s1'), b0)} ${c(65521)})` }],
	[
		'divu',
		{
			step1: `(i32.sub ${add(L('s1'), b0)} (i32.mul (i32.div_u ${add(L('s1'), b0)} ${c(65521)}) ${c(65521)}))`
		}
	],
	[
		'divu-one',
		{
			step1: `(i32.sub ${add(L('s1'), b0)} (i32.mul (i32.div_u ${add(L('s1'), b0)} ${c(65521)}) ${c(65520)}))`
		}
	],
	[
		'and-mask-fffe',
		{ step1: `(i32.and (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(65534)})` }
	],
	[
		'and-mask-ffff',
		{ step1: `(i32.and (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(65535)})` },
		65521
	],
	['and-mask-ff', { step1: `(i32.and (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(255)})` }],
	['or-one', { step1: `(i32.or (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(1)})` }],
	[
		'or-one-shl',
		{ step1: `(i32.or (i32.shl (i32.rem_u ${add(L('s1'), b0)} ${c(32760)}) ${c(1)}) ${c(1)})` }
	],
	['xor-const', { step1: xor(`(i32.rem_u ${add(L('s1'), b0)} ${c(65521)})`, c(1)) }],
	['rem-rem', { step1: `(i32.rem_u (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(251)})` }],
	[
		'rem-rem-same',
		{ step1: `(i32.rem_u (i32.rem_u ${add(L('s1'), b0)} ${c(65521)}) ${c(65521)})` },
		65521
	],
	['rem-rem-big', { step1: `(i32.rem_u (i32.rem_u ${add(L('s1'), b0)} ${c(251)}) ${c(65521)})` }],
	[
		'rem-sum-of-rems',
		{
			step2: `(i32.rem_u ${add(`(i32.rem_u ${L('s2')} ${c(65521)})`, `(i32.rem_u ${L('s1')} ${c(251)})`)} ${c(65521)})`
		}
	],
	['rem-byte', { step1: `(i32.rem_u ${add(L('s1'), `(i32.rem_u ${b0} ${c(7)})`)} ${c(65521)})` }],
	['byte-mul', { step1: `(i32.rem_u ${add(L('s1'), mul(b0, b0))} ${c(65521)})` }],
	[
		'byte-shl',
		{ step1: `(i32.rem_u ${add(L('s1'), `(i32.shl ${b0} ${c(3)})`)} ${c(65521)})` },
		65521
	],
	[
		'byte-and',
		{ step1: `(i32.rem_u ${add(L('s1'), `(i32.and ${b0} ${c(15)})`)} ${c(65521)})` },
		65521
	],
	['byte-xor', { step1: `(i32.rem_u ${add(L('s1'), xor(b0, c(85)))} ${c(65521)})` }, 65521],
	['byte-shr', { step1: `(i32.rem_u ${add(L('s1'), shr(b0, 2))} ${c(65521)})` }, 65521],
	['byte-twice', { step1: `(i32.rem_u ${add(add(L('s1'), b0), b0)} ${c(65521)})` }, 65521],
	['byte-next', { step1: `(i32.rem_u ${add(L('s1'), ld(A, 1))} ${c(65521)})` }],
	[
		'byte-prev',
		{ step1: `(i32.rem_u ${add(L('s1'), `(i32.load8_u (i32.sub ${A} ${c(1)}))`)} ${c(65521)})` }
	],
	['byte-signed', { step1: `(i32.rem_u ${add(L('s1'), `(i32.load8_s ${A})`)} ${c(65521)})` }],
	['byte-16', { step1: `(i32.rem_u ${add(L('s1'), `(i32.load16_u ${A})`)} ${c(65521)})` }],
	[
		's2-from-new-s1',
		{
			step2: `(i32.rem_u ${add(L('s2'), `(i32.rem_u ${add(L('s1'), b0)} ${c(65521)})`)} ${c(65521)})`
		}
	],
	['s2-mul', { step2: `(i32.rem_u ${add(mul(L('s2'), c(3)), L('s1'))} ${c(65521)})` }, 65521],
	['s2-const', { step2: `(i32.rem_u ${add(add(L('s2'), L('s1')), c(5))} ${c(65521)})` }, 65521],
	['s2-b', { step2: `(i32.rem_u ${add(add(L('s2'), L('s1')), b0)} ${c(65521)})` }, 65521],
	['s2-s2', { step2: `(i32.rem_u ${add(L('s2'), L('s2'))} ${c(65521)})` }],
	['s2-sq', { step2: `(i32.rem_u ${add(L('s2'), mul(L('s1'), L('s1')))} ${c(65521)})` }],
	['s1-sq', { step1: `(i32.rem_u ${mul(L('s1'), L('s1'))} ${c(65521)})` }],
	['s2-eq', { step2: `(i32.rem_u ${add(L('s2'), `(i32.eq ${L('s1')} ${c(0)})`)} ${c(65521)})` }],
	[
		's2-ltu',
		{ step2: `(i32.rem_u ${add(L('s2'), `(i32.lt_u ${L('s1')} ${c(1000)})`)} ${c(65521)})` }
	],
	[
		's2-sel',
		{
			step2: `(i32.rem_u ${add(L('s2'), `(select ${c(1)} ${c(2)} (i32.gt_u ${L('s1')} ${c(1000)}))`)} ${c(65521)})`
		}
	],
	['if-digit', { pre: `(if (i32.gt_u ${L('s1')} ${c(65000)}) (then ${set('s1', c(0))}))` }],
	[
		'if-n1',
		{
			step2: `(if (result i32) (i32.eq ${L('n')} ${c(1)}) (then ${add(L('s2'), L('s1'))}) (else (i32.rem_u ${add(L('s2'), L('s1'))} ${c(65521)})))`
		}
	],
	[
		'if-n2',
		{
			step2: `(if (result i32) (i32.eq ${L('n')} ${c(2)}) (then ${add(L('s2'), L('s1'))}) (else (i32.rem_u ${add(L('s2'), L('s1'))} ${c(65521)})))`
		}
	],
	[
		'if-n3-s1',
		{
			step1: `(if (result i32) (i32.eq ${L('n')} ${c(3)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	[
		'if-n17',
		{
			step1: `(if (result i32) (i32.eq ${L('n')} ${c(17)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	[
		'if-ge17',
		{
			step1: `(if (result i32) (i32.ge_u ${L('n')} ${c(17)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	[
		'if-ge4',
		{
			step1: `(if (result i32) (i32.ge_u ${L('n')} ${c(4)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	[
		'if-ge16',
		{
			step1: `(if (result i32) (i32.ge_u ${L('n')} ${c(16)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	[
		'if-i-first',
		{
			step1: `(if (result i32) (i32.eq ${L('i')} ${c(0)}) (then (i32.rem_u ${add(L('s1'), b0)} ${c(65519)})) (else (i32.rem_u ${add(L('s1'), b0)} ${c(65521)})))`
		}
	],
	['if-i-pos', { step1: `(i32.rem_u ${add(L('s1'), mul(b0, add(L('i'), c(1))))} ${c(65521)})` }],
	['n-dep', { step1: `(i32.rem_u ${add(L('s1'), add(b0, L('n')))} ${c(65521)})` }],
	['p-dep', { step1: `(i32.rem_u ${add(L('s1'), add(b0, shr(L('p'), 20)))} ${c(65521)})` }],
	[
		'post-rem',
		{ step1: add(L('s1'), b0), post: `${set('s1', `(i32.rem_u ${L('s1')} ${c(65521)})`)}` }
	],
	[
		'post-rem2',
		{
			step1: `(i32.rem_u ${add(L('s1'), b0)} ${c(65521)})`,
			step2: add(L('s2'), L('s1')),
			post: `${set('s2', `(i32.rem_u ${L('s2')} ${c(65521)})`)}`
		}
	],
	[
		'post-rem-both',
		{
			step1: add(L('s1'), b0),
			step2: add(L('s2'), L('s1')),
			post: `${set('s1', `(i32.rem_u ${L('s1')} ${c(65521)})`)} ${set('s2', `(i32.rem_u ${L('s2')} ${c(65521)})`)}`
		}
	],
	[
		'post-sub',
		{
			step1: `(i32.rem_u ${add(L('s1'), b0)} ${c(65521)})`,
			post: `${set('s2', `(i32.rem_u ${add(L('s2'), c(1))} ${c(65521)})`)}`
		}
	],
	[
		'pre-rem',
		{
			pre: `${set('s1', `(i32.rem_u ${L('s1')} ${c(65521)})`)} ${set('s2', `(i32.rem_u ${L('s2')} ${c(65521)})`)}`
		},
		65521
	],
	['pre-rem-one', { pre: `${set('s1', `(i32.rem_u ${L('s1')} ${c(65521)})`)}` }, 65521],
	['pre-add', { pre: `${set('s2', add(L('s2'), c(1)))}` }]
];
for (const [name, opts, p] of adlerVariants) {
	for (const shape of ['head', 'tail'] as const) {
		if (name.endsWith('-tail') || name.endsWith('-two')) {
			if (shape === 'tail') continue;
			push('rw-adler', name, adlerWat(opts), p ? { p } : undefined);
		} else
			push(
				'rw-adler',
				`${name}-${shape}`,
				adlerWat({ shape, ...opts }),
				p ? { p } : undefined
			);
	}
}

// #endregion

// #region output kernels in WAT

interface OutShape {
	stride: number;
	pre: string;
	post: string;
	shape: 'head' | 'tail';
	locals: string;
	extra: string;
	tailBody: string;
}
function outWat(body: string, o: Partial<OutShape> = {}): string {
	const a = {
		stride: 1,
		pre: '',
		post: '',
		shape: 'head',
		locals: '',
		extra: '',
		tailBody: '',
		...o
	};
	const inc = set('i', add(L('i'), c(a.stride)));
	let loop =
		a.shape === 'head'
			? `(block $done (loop $l (br_if $done (i32.ge_u ${add(L('i'), c(a.stride - 1))} ${L('n')})) ${body} ${inc} (br $l)))`
			: `(if (i32.ge_u ${L('n')} ${c(a.stride)}) (then (loop $l ${body} ${inc} (br_if $l (i32.lt_u ${L('i')} ${L('n')})))))`;
	if (a.tailBody)
		loop += `(block $d2 (loop $l2 (br_if $d2 (i32.ge_u ${L('i')} ${L('n')})) ${a.tailBody} ${set('i', add(L('i'), c(1)))} (br $l2)))`;
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $i i32) (local $t i32) (local $u i32) ${a.locals}
 ${a.pre}
 ${loop}
 ${a.post}
 ${L('s')})
 ${a.extra}`;
}
const lcg = set('s', add(mul(L('s'), c(1664525)), c(1013904223)));
const key = shr(L('s'), 24);
const xs = `${set('s', xor(L('s'), `(i32.shl ${L('s')} ${c(13)})`))} ${set('s', xor(L('s'), shr(L('s'), 17)))} ${set('s', xor(L('s'), `(i32.shl ${L('s')} ${c(5)})`))}`;
const tail1 = (name: string, body: string, o: Partial<OutShape> = {}) => {
	push('ow-loop', `${name}-head`, outWat(body, { ...o, shape: 'head' }));
	if (!o.stride || o.stride === 1)
		push('ow-loop', `${name}-tail`, outWat(body, { ...o, shape: 'tail' }));
};
tail1('xlcg', `${lcg} ${st(A, xor(ld(), key))}`);
tail1('xlcg-add', `${lcg} ${st(A, add(ld(), key))}`);
tail1('xlcg-sub', `${lcg} ${st(A, `(i32.sub ${key} ${ld()})`)}`);
tail1('xlcg-mul', `${lcg} ${st(A, xor(mul(ld(), c(3)), key))}`);
tail1('xlcg-old', `${st(A, xor(ld(), key))} ${lcg}`);
tail1('xlcg-no-mask', `${lcg} ${st(A, xor(ld(), L('s')))}`);
tail1('xs', `${xs} ${st(A, xor(ld(), L('s')))}`);
tail1('xs-add', `${xs} ${st(A, add(ld(), L('s')))}`);
tail1('xs-rot', `${xs} ${st(A, `(i32.rotl ${ld()} ${c(3)})`)}`);
tail1('xs-and', `${xs} ${st(A, `(i32.and ${ld()} ${L('s')})`)}`);
tail1('xs-or', `${xs} ${st(A, `(i32.or ${ld()} ${L('s')})`)}`);
tail1('feed', `${set('s', add(mul(L('s'), c(31)), ld()))} ${st(A, xor(ld(), key))}`);
tail1(
	'feed-ct',
	`${set('t', xor(ld(), key))} ${st(A, L('t'))} ${set('s', add(mul(L('s'), c(31)), L('t')))}`
);
tail1(
	'feed-pt',
	`${set('t', ld())} ${st(A, xor(L('t'), key))} ${set('s', add(mul(L('s'), c(31)), L('t')))}`
);
tail1('readback', `${st(A, xor(ld(), key))} ${set('s', add(mul(L('s'), c(31)), ld()))}`);
tail1('store-then-load-state', `${lcg} ${st(A, key)} ${set('s', add(L('s'), ld()))}`);
tail1(
	'store-then-load-t',
	`${lcg} ${st(A, key)} ${set('t', ld())} ${set('s', add(L('s'), L('t')))}`
);
tail1(
	'load-store-load',
	`${set('t', ld())} ${lcg} ${st(A, xor(L('t'), key))} ${set('s', add(L('s'), ld()))}`
);
tail1('double-store', `${lcg} ${st(A, key)} ${st(A, xor(key, c(1)))}`);
tail1('double-store-ld', `${lcg} ${st(A, xor(ld(), key))} ${st(A, xor(ld(), c(1)))}`);
tail1('double-store-same', `${lcg} ${st(A, xor(ld(), key))} ${st(A, xor(ld(), key))}`);
tail1('store-next', `${lcg} ${st(A, xor(ld(), key), 1)}`);
tail1('store-prev', `${lcg} ${st(`(i32.sub ${A} ${c(1)})`, xor(ld(), key))}`);
tail1('load-prev', `${lcg} ${st(A, xor(`(i32.load8_u (i32.sub ${A} ${c(1)}))`, key))}`);
tail1('load-next', `${lcg} ${st(A, xor(ld(A, 1), key))}`);
tail1('store-two-bytes', `${lcg} ${st(A, xor(ld(), key))} ${st(A1, xor(ld(A1), key))}`);
tail1('store16', `${lcg} (i32.store16 ${A} ${xor(`(i32.load16_u ${A})`, key)})`);
tail1('store32', `${lcg} (i32.store ${A} ${xor(`(i32.load ${A})`, L('s'))})`);
tail1('load16-store8', `${lcg} ${st(A, xor(`(i32.load16_u ${A})`, key))}`);
tail1('load32-store8', `${lcg} ${st(A, xor(`(i32.load ${A})`, key))}`);
tail1('store-const', `${lcg} ${st(A, c(7))}`);
tail1('store-const-load', `${lcg} ${set('t', ld())} ${st(A, c(7))}`);
tail1(
	'store-state-only',
	`${lcg} ${set('t', ld())} ${set('s', add(L('s'), L('t')))} ${st(A, key)}`
);
tail1('store-index', `${lcg} ${st(A, xor(ld(), L('i')))}`);
tail1('store-ptr', `${lcg} ${st(A, xor(ld(), shr(L('p'), 3)))}`);
tail1('store-n', `${lcg} ${st(A, xor(ld(), L('n')))}`);
tail1('store-rem', `${lcg} ${st(A, xor(ld(), `(i32.sub ${L('n')} ${L('i')})`))}`);
tail1(
	'store-s-cond',
	`${lcg} ${st(A, `(select ${xor(ld(), key)} ${ld()} (i32.and ${L('s')} ${c(256)}))`)}`
);
tail1('store-if-byte', `${lcg} (if (i32.and ${ld()} ${c(1)}) (then ${st(A, key)}))`);
tail1(
	'store-if-state',
	`${lcg} (if (i32.and ${L('s')} ${c(256)}) (then ${st(A, xor(ld(), key))}))`
);
tail1(
	'store-if-state-else',
	`${lcg} (if (i32.and ${L('s')} ${c(256)}) (then ${st(A, xor(ld(), key))}) (else ${st(A, ld())}))`
);
tail1(
	'store-if-i',
	`${lcg} (if (i32.eq ${L('i')} ${c(5)}) (then ${st(A, xor(ld(), key))}) (else ${st(A, ld())}))`
);
tail1('store-addr-state', `${lcg} ${st(add(L('p'), shr(L('s'), 28)), key)}`);
tail1('store-addr-byte', `${lcg} ${st(add(L('p'), ld()), key)}`);
tail1(
	'load-addr-state',
	`${lcg} ${st(A, xor(`(i32.load8_u (i32.add ${L('p')} ${shr(L('s'), 30)}))`, key))}`
);
tail1('i-times-two', `${lcg} ${st(`(i32.add ${L('p')} (i32.shl ${L('i')} ${c(1)}))`, key)}`);
tail1(
	'sbox',
	`${set('s', add(L('s'), c(1)))} ${st(A, xor(ld(), `(i32.load8_u offset=2048 (i32.and ${L('s')} ${c(255)}))`))}`
);
tail1(
	'sbox-state',
	`${set('s', `(i32.load8_u offset=2048 (i32.and ${add(L('s'), ld())} ${c(255)}))`)} ${st(A, xor(ld(), L('s')))}`
);
tail1(
	'sbox-in-input',
	`${set('s', add(L('s'), c(1)))} ${st(A, xor(ld(), `(i32.load8_u offset=1048576 (i32.and ${L('s')} ${c(255)}))`))}`
);
tail1(
	'sbox-in-input-hi',
	`${set('s', add(L('s'), c(1)))} ${st(A, xor(ld(), `(i32.load8_u offset=1048624 (i32.and ${L('s')} ${c(255)}))`))}`
);
tail1('zero-write', `${st(A, c(0))}`);
tail1('noop-state', `${set('s', add(L('s'), ld()))}`);
tail1('inc', `${set('s', add(L('s'), c(1)))} ${st(A, add(ld(), c(1)))}`);
tail1('copy-next-state', `${set('t', ld())} ${st(A, L('s'))} ${set('s', L('t'))}`);
tail1(
	'copy-next-state-xor',
	`${set('t', ld())} ${st(A, xor(L('t'), L('s')))} ${set('s', xor(L('s'), L('t')))}`
);
tail1('byte-state', `${set('s', xor(L('s'), ld()))} ${st(A, L('s'))}`);
tail1('byte-state-shl', `${set('s', xor(`(i32.shl ${L('s')} ${c(1)})`, ld()))} ${st(A, L('s'))}`);
tail1(
	'byte-state-shl8',
	`${set('s', xor(`(i32.shl ${L('s')} ${c(8)})`, ld()))} ${st(A, shr(L('s'), 8))}`
);
tail1('byte-state-xs', `${set('s', xor(L('s'), ld()))} ${xs} ${st(A, L('s'))}`);

// stride two
for (const [name, body] of [
	['ok', `${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`],
	[
		'bad-lane1-key',
		`${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), shr(L('s'), 23)))}`
	],
	['bad-lane1-nolcg', `${lcg} ${st(A, xor(ld(), key))} ${st(A1, xor(ld(A1), key))}`],
	['bad-lane0-nolcg', `${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`],
	['cross-read', `${lcg} ${st(A, xor(ld(A1), key))} ${lcg} ${st(A1, xor(ld(A), key))}`],
	['one-store', `${lcg} ${st(A, xor(ld(), key))} ${lcg} ${set('t', ld(A1))}`],
	['one-store-state', `${lcg} ${st(A, xor(ld(), key))} ${set('s', add(L('s'), ld(A1)))}`],
	['swap', `${set('t', ld())} ${st(A, ld(A1))} ${st(A1, L('t'))} ${set('s', add(L('s'), c(1)))}`],
	['reverse-order', `${lcg} ${st(A1, xor(ld(A1), key))} ${lcg} ${st(A, xor(ld(), key))}`],
	[
		'double-first',
		`${lcg} ${st(A, xor(ld(), key))} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`
	],
	['load-after-first', `${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A), key))}`],
	[
		'load16',
		`${lcg} ${st(A, xor(`(i32.and (i32.load16_u ${A}) ${c(255)})`, key))} ${lcg} ${st(A1, xor(shr(`(i32.load16_u ${A})`, 8), key))}`
	],
	[
		'load16-swap',
		`${lcg} ${st(A, xor(shr(`(i32.load16_u ${A})`, 8), key))} ${lcg} ${st(A1, xor(`(i32.and (i32.load16_u ${A}) ${c(255)})`, key))}`
	],
	[
		'load16-store-after',
		`${lcg} (local.set $t (i32.load16_u ${A})) ${st(A, xor(`(i32.and ${L('t')} ${c(255)})`, key))} ${lcg} ${st(A1, xor(shr(L('t'), 8), key))}`
	],
	[
		'hash-both',
		`${set('s', add(mul(L('s'), c(31)), add(ld(), ld(A1))))} ${st(A, xor(ld(), key))} ${st(A1, xor(ld(A1), key))}`
	]
] as [string, string][]) {
	push(
		'ow-stride2',
		`${name}-head`,
		outWat(body, { stride: 2, shape: 'head', tailBody: `${lcg} ${st(A, xor(ld(), key))}` })
	);
}
push(
	'ow-stride2',
	'ok-badtail',
	outWat(`${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`, {
		stride: 2,
		tailBody: `${lcg} ${st(A, xor(ld(), shr(L('s'), 23)))}`
	})
);
push(
	'ow-stride2',
	'ok-badtail-state',
	outWat(`${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`, {
		stride: 2,
		tailBody: `${set('s', add(L('s'), c(1)))} ${st(A, xor(ld(), key))}`
	})
);
push(
	'ow-stride2',
	'ok-notail',
	outWat(`${lcg} ${st(A, xor(ld(), key))} ${lcg} ${st(A1, xor(ld(A1), key))}`, { stride: 2 })
);

// conditionals around the loop and fixed addresses
const base = `${lcg} ${st(A, xor(ld(), key))}`;
const loopPost = (name: string, post: string, pre = '', extra = '') =>
	push('ow-post', name, outWat(base, { post, pre, extra }));
loopPost('n17-store3', `(if (i32.ge_u ${L('n')} ${c(17)}) (then ${st(add(L('p'), c(3)), c(1))}))`);
loopPost(
	'n17-store-last',
	`(if (i32.eq ${L('n')} ${c(17)}) (then ${st(add(L('p'), c(16)), c(1))}))`
);
loopPost('n7-fixed-in-range', `(if (i32.eq ${L('n')} ${c(7)}) (then ${st(c(1048580), c(1))}))`);
loopPost('n7-fixed-out-of-range', `(if (i32.eq ${L('n')} ${c(7)}) (then ${st(c(100), c(1))}))`);
loopPost('fixed-always-store', st(c(100), c(1)));
loopPost('fixed-lazy', `(if (i32.eqz (i32.load8_u (i32.const 100))) (then ${st(c(100), c(1))}))`);
loopPost(
	'fixed-lazy-in-range',
	`(if (i32.eqz (i32.load8_u (i32.const 1048580))) (then ${st(c(1048580), c(1))}))`
);
loopPost('mem-fill', `(memory.fill ${L('p')} ${c(0)} ${c(1)})`);
loopPost('mem-copy', `(memory.copy ${L('p')} ${add(L('p'), c(1))} ${c(1)})`);
loopPost('mem-fill-n', `(memory.fill ${L('p')} ${c(0)} ${L('n')})`);
loopPost('fill-first-byte-pre', '', `(memory.fill ${L('p')} ${c(0)} ${c(1)})`);
loopPost(
	'second-fn',
	`(call $h ${L('p')} ${L('n')} ${L('s')})`,
	'',
	`(func $h (param $p i32) (param $n i32) (param $s i32) ${st(L('p'), L('s'))})`
);
loopPost(
	'second-fn-in-loop-eq',
	``,
	'',
	`(func $h (param $p i32) (param $n i32) (param $s i32) (nop))`
);
loopPost('pre-store-first', ``, `${st(L('p'), c(9))}`);
loopPost(
	'pre-store-last',
	``,
	`(if (i32.ge_u ${L('n')} ${c(1)}) (then ${st(add(L('p'), c(0)), xor(ld(L('p')), c(1)))}))`
);
loopPost(
	'post-store-last-byte',
	`(if (i32.ge_u ${L('n')} ${c(1)}) (then ${st(`(i32.add ${L('p')} (i32.sub ${L('n')} ${c(1)}))`, xor(`(i32.load8_u (i32.add ${L('p')} (i32.sub ${L('n')} ${c(1)})))`, c(1)))}))`
);
loopPost('tail-extra', `(if (i32.ge_u ${L('n')} ${c(1)}) (then ${set('s', add(L('s'), c(1)))}))`);
loopPost('state-post', `${set('s', xor(L('s'), c(0)))}`);

// #endregion

export const wSpecs = out;
