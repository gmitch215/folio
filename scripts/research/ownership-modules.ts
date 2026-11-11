import binaryen from 'binaryen';

// hand-written bulk drivers: the table is 4 words per record (data, length, aux, arena), the output slot 64 bytes
export const TABLE = 8192;
export const OUT = 12288;
export const DATA = 16384;
export const ARENA = 40960;
export const RECORDS = 8;

export const assemble = (wat: string): Uint8Array<ArrayBuffer> => {
	const module = binaryen.parseText(wat);
	const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
	module.setFeatures(binaryen.Features.All & ~compact);
	if (!module.validate()) throw new Error('invalid module\n' + wat);
	const bytes = Uint8Array.from(module.emitBinary());
	module.dispose();
	return bytes;
};

export interface Frame {
	body: string;
	extra?: string;
	/** an i32 expression that the entry returns; without it the entry returns nothing */
	ret?: string;
	/** the declared maximum of the imported memory, in pages; the slice pool needs one */
	max?: number;
}

export const driverWat = ({
	body,
	extra = '',
	ret
}: Frame) => `(module (import "env" "memory" (memory 8))
	${extra}
	(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)${ret ? ' (result i32)' : ''}
		(local $i i32) (local $p i32) (local $len i32) (local $k i32) (local $sum i32) (local $arena i32) (local $slot i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $p (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))))
			(local.set $len (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 4)))))
			(local.set $arena (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 12)))))
			(local.set $slot (i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6))))
			(local.set $sum (i32.const 0)) (local.set $k (i32.const 0))
			(block $sd (loop $sl
				(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
				(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
				(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))
			${body}
			(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))
		${ret ?? ''})
)`;

// the same record body in a callee, called from a countdown loop: the shape the iteration route takes
export const iterWat = ({
	body,
	extra = '',
	ret,
	max
}: Frame) => `(module (import "env" "memory" (memory 8${max ? ` ${max}` : ''}))
	${extra}
	(func $rec (param $t i32) (param $o i32)
		(local $p i32) (local $len i32) (local $k i32) (local $sum i32) (local $arena i32) (local $slot i32)
		(local.set $p (i32.load (local.get $t)))
		(local.set $len (i32.load offset=4 (local.get $t)))
		(local.set $arena (i32.load offset=12 (local.get $t)))
		(local.set $slot (local.get $o))
		(block $sd (loop $sl
			(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
			(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
			(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))
		${body})
	(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)${ret ? ' (result i32)' : ''}
		(loop $each
			(call $rec (local.get $t) (local.get $o))
			(local.set $t (i32.add (local.get $t) (i32.const 16)))
			(local.set $o (i32.add (local.get $o) (i32.const 64)))
			(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
		${ret ?? ''})
)`;

export const SYNTHETIC: Record<string, string> = {
	clean: '(i32.store (local.get $slot) (local.get $sum))',
	counter: `(i32.store (i32.const 4096) (i32.add (i32.load (i32.const 4096)) (i32.const 1)))
		(i32.store (local.get $slot) (local.get $sum))`,
	rare: `(if (i32.eq (i32.load8_u (local.get $p)) (i32.const 255)) (then (i32.store (i32.const 4100) (i32.const 1))))
		(i32.store (local.get $slot) (local.get $sum))`,
	carry: `(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.load (i32.const 4104))))
		(i32.store (i32.const 4104) (local.get $sum))`,
	cursor: `(i32.store (i32.const 4112) (local.get $arena))
		(i32.store (i32.const 4112) (i32.add (i32.load (i32.const 4112)) (i32.const 16)))
		(i32.store (local.get $slot) (i32.load (i32.const 4112)))`,
	scratch: `(i32.store (i32.const 4120) (local.get $sum))
		(i32.store (i32.const 4124) (i32.add (i32.load (i32.const 4120)) (i32.const 1)))
		(i32.store (local.get $slot) (i32.load (i32.const 4124)))`
};

const IMPORT_F = '(import "env" "f" (func $f (param i32)))';
const TABLE_NOP = '(table 1 funcref) (type $nt (func)) (elem (i32.const 0) $nop) (func $nop)';
const GLOBAL_G = '(global $g (mut i32) (i32.const 0))';

export interface Statement {
	text: string;
}

/** A base body is a list of statements; operators work on the list. */
export const BASES: Record<string, string[]> = {
	scratch: [
		'(i32.store (i32.const 4120) (local.get $sum))',
		'(i32.store (i32.const 4124) (i32.add (i32.load (i32.const 4120)) (i32.const 1)))',
		'(i32.store (local.get $slot) (i32.load (i32.const 4124)))'
	],
	fill: [
		'(memory.fill (i32.const 4096) (i32.const 7) (i32.const 64))',
		'(i32.store (i32.const 4100) (i32.add (i32.load (i32.const 4100)) (local.get $sum)))',
		'(i32.store (local.get $slot) (i32.load (i32.const 4100)))'
	],
	loop: [
		`(local.set $k (i32.const 0))
		(block $cb (loop $cl
			(br_if $cb (i32.ge_u (local.get $k) (i32.const 64)))
			(i32.store8 (i32.add (i32.const 4096) (local.get $k)) (i32.add (local.get $sum) (local.get $k)))
			(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $cl)))`,
		'(i32.store (local.get $slot) (i32.load (i32.const 4130)))'
	],
	branch: [
		`(if (i32.and (local.get $sum) (i32.const 1))
			(then (i32.store (i32.const 4120) (local.get $sum)))
			(else (i32.store (i32.const 4120) (i32.const 5))))`,
		'(i32.store (local.get $slot) (i32.load (i32.const 4120)))'
	],
	bounded: [
		'(memory.fill (i32.const 4096) (i32.const 3) (i32.const 16))',
		'(i32.store8 (i32.add (i32.const 4096) (i32.and (local.get $sum) (i32.const 15))) (local.get $sum))',
		'(i32.store (local.get $slot) (i32.load8_u (i32.add (i32.const 4096) (i32.and (local.get $len) (i32.const 15)))))'
	],
	copy: [
		'(i32.store (i32.const 4160) (local.get $sum))',
		'(i32.store (i32.const 4164) (local.get $len))',
		'(memory.copy (local.get $slot) (i32.const 4160) (i32.const 8))'
	]
};

const WAIT = '(i32.and (local.get $sum) (i32.const 1))';

/** Statements that an insertion operator can add; `expect` lists the reasons the checker may give. */
export const INSERTS: Record<
	string,
	{ text: string; extra?: string; ret?: string; expect: string[] }
> = {
	'fill-over-window': {
		text: '(memory.fill (i32.const 4096) (i32.const 0) (i32.const 64))',
		expect: ['none', 'read-before-write', 'final-state']
	},
	'fill-straddle': {
		text: '(memory.fill (i32.const 4100) (i32.const 0) (local.get $len))',
		expect: ['aliasing']
	},
	'fill-dynamic': {
		text: '(memory.fill (i32.add (i32.const 4096) (i32.load (local.get $p))) (i32.const 0) (i32.const 8))',
		expect: ['aliasing']
	},
	'fill-bounded': {
		text: '(memory.fill (i32.add (i32.const 4096) (i32.and (local.get $sum) (i32.const 255))) (i32.const 0) (i32.const 8))',
		expect: ['none', 'final-state', 'read-before-write']
	},
	'copy-from-window': {
		text: '(memory.copy (local.get $slot) (i32.const 4090) (i32.const 16))',
		expect: ['aliasing']
	},
	'store-address': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.const 4120))',
		expect: ['escape']
	},
	'store-address-field': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.add (i32.const 4120) (i32.const 4)))',
		expect: ['escape']
	},
	'return-address': {
		text: '',
		ret: '(i32.const 4120)',
		expect: ['escape']
	},
	'import-address': {
		text: '(call $f (i32.const 4120))',
		extra: IMPORT_F,
		expect: ['escape']
	},
	'import-plain': {
		text: '(call $f (local.get $sum))',
		extra: IMPORT_F,
		expect: ['isolation']
	},
	'indirect-call': {
		text: '(call_indirect (type $nt) (i32.const 0))',
		extra: TABLE_NOP,
		expect: ['isolation']
	},
	'global-write': {
		text: '(global.set $g (local.get $sum))',
		extra: GLOBAL_G,
		expect: ['isolation']
	},
	'global-counter': {
		text: '(global.set $g (i32.add (global.get $g) (i32.const 1)))',
		extra: GLOBAL_G,
		expect: ['isolation']
	},
	'trap-after-write': {
		text: `(if ${WAIT} (then (unreachable)))`,
		expect: ['failure', 'none']
	},
	'cursor-store': {
		text: '(i32.store (i32.const 4112) (local.get $arena))',
		expect: ['allocator']
	},
	'table-pointer-store': {
		text: '(i32.store (i32.const 4112) (local.get $t))',
		expect: ['allocator']
	},
	'late-read': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 12)) (i32.load (i32.const 4200)))',
		expect: ['none', 'read-before-write', 'final-state']
	},
	'dynamic-store': {
		text: '(i32.store8 (i32.add (i32.const 4096) (i32.load8_u (local.get $p))) (i32.const 1))',
		expect: ['none', 'final-state', 'read-before-write']
	},
	'wide-dynamic-store': {
		text: '(i32.store (i32.add (i32.const 4096) (i32.mul (local.get $sum) (i32.const 5))) (i32.const 1))',
		expect: ['none', 'final-state', 'read-before-write']
	}
};

export const buildBody = (statements: string[]) => statements.join('\n\t\t');

export const moduleOf = (statements: string[], insert?: string): Uint8Array<ArrayBuffer> => {
	const add = insert ? INSERTS[insert]! : undefined;
	const all = add?.text ? [...statements, add.text] : statements;
	return assemble(driverWat({ body: buildBody(all), extra: add?.extra ?? '', ret: add?.ret }));
};

export const wasmOf = (name: string) => assemble(driverWat({ body: SYNTHETIC[name]! }));

const SCRATCH = `(i32.store (i32.const 4120) (local.get $sum))
	(i32.store (i32.const 4124) (i32.add (i32.load (i32.const 4120)) (i32.const 1)))
	(i32.store (local.get $slot) (i32.load (i32.const 4124)))`;

const COUNT_FN = '(func $put (param i32 i32) (i32.store offset=4 (local.get 0) (local.get 1)))';
const BY_I = '(i32.add (i32.const 4200) (local.get $i))';

/** A loop counter of the entry in a record body; `keep` has to certify, the rest has to be refused. */
export interface CounterUse {
	body: string;
	keep?: boolean;
	extra?: string;
}

export const COUNTER_USES: Record<string, CounterUse> = {
	'address-slot': {
		keep: true,
		body: `${SCRATCH}
			(i32.store (i32.add (local.get $o) (i32.add (i32.shl (local.get $i) (i32.const 6)) (i32.const 8))) (local.get $sum))`
	},
	'address-table': {
		keep: true,
		body: `${SCRATCH}
			(i32.store offset=12 (local.get $slot) (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 8)))))`
	},
	'two-counters-address': {
		keep: true,
		body: `${SCRATCH}
			(i32.store offset=20 (i32.add (local.get $o) (i32.shl (local.get $j) (i32.const 5))) (local.get $sum))
			(local.set $j (i32.add (local.get $j) (i32.const 2)))`
	},
	'data-direct': { body: `${SCRATCH} (i32.store offset=4 (local.get $slot) (local.get $i))` },
	'data-after-add': {
		body: `${SCRATCH} (i32.store offset=4 (local.get $slot) (i32.add (local.get $sum) (local.get $i)))`
	},
	'data-after-shift': {
		body: `${SCRATCH} (i32.store offset=4 (local.get $slot) (i32.shl (local.get $i) (i32.const 3)))`
	},
	'data-after-mask': {
		body: `${SCRATCH} (i32.store offset=4 (local.get $slot) (i32.and (local.get $i) (i32.const 255)))`
	},
	'data-through-local': {
		body: `${SCRATCH} (local.set $q (local.get $i)) (i32.store offset=4 (local.get $slot) (local.get $q))`
	},
	'data-through-call': {
		extra: COUNT_FN,
		body: `${SCRATCH} (call $put (local.get $slot) (local.get $i))`
	},
	'data-select': {
		body: `${SCRATCH} (i32.store offset=4 (local.get $slot)
			(select (local.get $i) (local.get $sum) (i32.and (local.get $sum) (i32.const 1))))`
	},
	'data-store8': { body: `${SCRATCH} (i32.store8 offset=4 (local.get $slot) (local.get $i))` },
	'data-store16': { body: `${SCRATCH} (i32.store16 offset=4 (local.get $slot) (local.get $i))` },
	'data-extend': {
		body: `${SCRATCH} (i64.store offset=8 (local.get $slot) (i64.extend_i32_u (local.get $i)))`
	},
	'data-table-index': {
		body: `${SCRATCH} (i32.store offset=4 (local.get $slot) (i32.load8_u ${BY_I}))`
	},
	'data-fill': {
		body: `${SCRATCH} (memory.fill (i32.const 4128) (local.get $i) (i32.const 8))`
	},
	'data-second-counter': {
		body: `${SCRATCH}
			(i32.store offset=24 (local.get $slot) (local.get $j))
			(local.set $j (i32.add (local.get $j) (i32.const 2)))`
	},
	'address-constant-base': {
		body: `${SCRATCH} (i32.store (i32.add (i32.const 4136) (i32.shl (local.get $i) (i32.const 2))) (local.get $sum))`
	}
};

export const counterModule = (
	use: CounterUse & { replace?: [string, string][] }
): Uint8Array<ArrayBuffer> => {
	let wat = driverWat({ body: use.body, extra: use.extra })
		.replace('(memory 8)', '(memory 8 40)')
		.replace('(local $i i32)', '(local $i i32) (local $q i32) (local $j i32)');
	for (const [from, to] of use.replace ?? []) wat = wat.replace(from, to);
	return assemble(wat);
};

export const iterModuleOf = (
	statements: string[],
	insert?: string,
	max?: number
): Uint8Array<ArrayBuffer> => {
	const add = insert ? INSERTS[insert]! : undefined;
	const all = add?.text ? [...statements, add.text] : statements;
	return assemble(iterWat({ body: buildBody(all), extra: add?.extra ?? '', ret: add?.ret, max }));
};

// ground truth: the serial run against the reference route, one record per call
export interface Outcome {
	trapped: number | null;
	memory: Uint8Array;
}

const prng = (seed: number) => {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s & 255;
	};
};

export function layoutRecords(view: Uint8Array, words: Uint32Array, seed: number) {
	const next = prng(seed);
	for (let i = 0; i < RECORDS; i++) {
		const at = DATA + i * 320;
		const length = 16 + (next() % 48);
		for (let k = 0; k < length; k++) view[at + k] = next() % 254;
		if (seed % 3 === 0 && i === 3) view[at] = 255;
		words[(TABLE + 16 * i) / 4] = at;
		words[(TABLE + 16 * i + 4) / 4] = length;
		words[(TABLE + 16 * i + 12) / 4] = ARENA + i * 64;
	}
}

/** Runs the module over the records. With `windows` each record starts from the baseline bytes of the windows. */
export function runRecords(
	bytes: Uint8Array,
	seed: number,
	windows: { low: number; end: number }[] | undefined
): Outcome {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer);
	layoutRecords(view, words, seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory, f: () => {} }
	});
	const bulk = instance.exports.bulk as (t: number, n: number, o: number) => number;
	const baseline = windows ? windows.map((w) => view.slice(w.low, w.end)) : [];
	let trapped: number | null = null;
	for (let i = 0; i < RECORDS; i++) {
		if (windows) windows.forEach((w, k) => view.set(baseline[k]!, w.low));
		try {
			bulk(TABLE + 16 * i, 1, OUT + 64 * i);
		} catch {
			trapped = i;
			break;
		}
	}
	return { trapped, memory: view.slice() };
}

/** True when the route (private window per record, last record copied out) equals the serial run. */
export function routeMatches(
	bytes: Uint8Array,
	windows: { low: number; end: number }[],
	seeds: number[]
): boolean {
	for (const seed of seeds) {
		const serial = runRecords(bytes, seed, undefined);
		const route = runRecords(bytes, seed, windows);
		if (serial.trapped !== route.trapped) return false;
		if (serial.trapped !== null) continue;
		const a = serial.memory;
		const b = route.memory;
		for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
	}
	return true;
}
