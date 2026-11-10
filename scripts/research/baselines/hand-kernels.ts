import binaryen from 'binaryen';
import type { StreamSubject } from './morihata.ts';

// $s is the state and $x the byte; the body is a wat expression that becomes the new state
const wat = (body: string) => `(module
	(memory (export "memory") 1)
	(func (export "f") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $i i32) (local $x i32)
		(block $done (loop $next
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $x (i32.load8_u (i32.add (local.get $p) (local.get $i))))
			(local.set $s ${body})
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $next)))
		(local.get $s)))`;

const get = (name: string) => `(local.get $${name})`;
const c = (value: number) => `(i32.const ${value | 0})`;

const crcStep = () => {
	let body = `(i32.xor ${get('s')} ${get('x')})`;
	for (let bit = 0; bit < 8; bit++)
		body = `(i32.xor (i32.shr_u ${body} ${c(1)}) (i32.mul (i32.and ${body} ${c(1)}) ${c(0xedb88320)}))`;
	return body;
};

export interface HandKernel {
	name: string;
	body: string;
	// what the baseline must report: a semiring name, or the class of the refusal
	expect: string;
}

export const handKernels: HandKernel[] = [
	{ name: 'sum', body: `(i32.add ${get('s')} ${get('x')})`, expect: 'add-mul' },
	{
		name: 'poly31',
		body: `(i32.add (i32.mul ${get('s')} ${c(31)}) ${get('x')})`,
		expect: 'add-mul'
	},
	{
		name: 'max-suffix',
		body: `(select ${c(0)} (i32.add ${get('s')} (i32.sub ${get('x')} ${c(128)})) (i32.lt_s (i32.add ${get('s')} (i32.sub ${get('x')} ${c(128)})) ${c(0)}))`,
		expect: 'max-add'
	},
	{
		name: 'running-max',
		body: `(select ${get('s')} ${get('x')} (i32.gt_s ${get('s')} ${get('x')}))`,
		expect: 'max-add'
	},
	{ name: 'crc32-step', body: crcStep(), expect: 'state-outside-class' },
	{
		name: 'fnv1a',
		body: `(i32.mul (i32.xor ${get('s')} ${get('x')}) ${c(16777619)})`,
		expect: 'state-outside-class'
	},
	{
		name: 'mod251',
		body: `(i32.rem_u (i32.add (i32.mul ${get('s')} ${c(3)}) ${get('x')}) ${c(251)})`,
		expect: 'state-outside-class'
	},
	{
		name: 'mod65521',
		body: `(i32.rem_u (i32.add ${get('s')} ${get('x')}) ${c(65521)})`,
		expect: 'end-to-end-mismatch'
	}
];

// a sum that adds one more once the state passes 2^28: no sample of a few KiB reaches it
export const lateDeviation: HandKernel = {
	name: 'late-deviation',
	body: `(i32.add (i32.add ${get('s')} ${get('x')}) (i32.gt_u ${get('s')} ${c(1 << 28)}))`,
	expect: 'add-mul'
};

export function buildHand(kernel: HandKernel): StreamSubject {
	const module = binaryen.parseText(wat(kernel.body));
	if (!module.validate()) throw new Error(`hand kernel ${kernel.name} does not validate`);
	const module8 = Uint8Array.from(module.emitBinary());
	module.dispose();
	return { module: module8, entry: 'f', bits: 32 };
}
