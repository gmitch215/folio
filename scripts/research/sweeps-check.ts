/**
 * Calibration before the measurements: every subject composes over a split (a chunk run from the
 * real state equals the serial call), and the candidate subjects agree with a plain reference.
 * Prints one line per check; exits 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { buildSubjects, subjects } from './sweeps-build.ts';
import { Instance, bounds } from './sweeps-engine.ts';
import { kinds, makeInput } from './sweeps-inputs.ts';

const paths = buildSubjects();
const size = 65536;
const k = 8;
let failed = 0;
const report = (ok: boolean, line: string) => {
	if (!ok) failed++;
	console.log(`${ok ? 'pass' : 'FAIL'} ${line}`);
};

for (const { name } of subjects) {
	const module = new WebAssembly.Module(readFileSync(paths[name]));
	const instance = new Instance(module, name);
	for (const kind of kinds) {
		const input = makeInput(name, kind, size);
		instance.load(input);
		const serial = instance.run(0, 0, size);
		const split = bounds(size, k, name);
		let state = 0;
		for (let i = 0; i < k; i++) state = instance.run(state, split[i]!, split[i + 1]!);
		report(
			state === serial,
			`${name} ${kind} composes over ${k} chunks (${serial} vs ${state})`
		);
	}
}

// reference checks on the inputs each subject is meant to see
const check = (
	name: string,
	kind: (typeof kinds)[number],
	f: (instance: Instance, input: Uint8Array) => boolean,
	label: string
) => {
	const module = new WebAssembly.Module(readFileSync(paths[name as keyof typeof paths]));
	const instance = new Instance(module, name);
	const input = makeInput(name, kind, size);
	instance.load(input);
	report(f(instance, input), `${name} ${kind}: ${label}`);
};

check(
	'crc32',
	'text',
	(instance, input) => instance.run(0, 0, size) === crc32(input),
	'matches zlib.crc32'
);
check(
	'crc32',
	'random',
	(instance, input) => instance.run(0, 0, size) === crc32(input),
	'matches zlib.crc32'
);
check(
	'utf8flag',
	'text',
	(instance, input) => {
		const valid = (() => {
			try {
				new TextDecoder('utf-8', { fatal: true }).decode(input);
				return true;
			} catch {
				return false;
			}
		})();
		return valid && instance.run(0, 0, size) >> 8 === 0;
	},
	'valid UTF-8 has no error flag'
);
check(
	'utf8flag',
	'adv',
	(instance) => instance.run(0, 0, size) >> 8 === 1,
	'error flag set by overlong sequences'
);
check(
	'base64ok',
	'text',
	(instance) => instance.run(0, 0, size) >> 3 === 0,
	'valid MIME base64 is not rejected'
);
check(
	'base64ok',
	'random',
	(instance) => instance.run(0, 0, size) >> 3 === 1,
	'random bytes are rejected'
);
check(
	'rle',
	'random',
	(instance) => instance.run(0, 0, size) >> 17 === 1,
	'random bytes hit a zero count'
);
check(
	'rle',
	'text',
	(instance) => instance.run(0, 0, size) >> 17 === 0,
	'text-like pairs are not rejected'
);
check(
	'csvquote',
	'text',
	(instance, input) => {
		let q = 0;
		for (const b of input) q ^= b === 0x22 ? 1 : 0;
		return instance.run(0, 0, size) === q;
	},
	'in-quote bit is the quote parity'
);
check(
	'csvquote',
	'adv',
	(instance) => instance.run(0, 0, size) === 1,
	'unclosed quote ends in quote'
);
check(
	'lines',
	'text',
	(instance, input) => {
		let s = 0;
		for (const b of input) s = b === 0x0a ? 0 : b === 0x09 ? s ^ 1 : s;
		return instance.run(0, 0, size) === s;
	},
	'tab parity since last newline'
);

if (failed) {
	console.log(`${failed} check(s) failed`);
	process.exitCode = 1;
}
