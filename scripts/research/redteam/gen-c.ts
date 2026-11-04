import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { cases, clang, env } from '../affine-build.ts';
import { outputDirectory, runBatch, type Entry } from './lib.ts';

// compiled shapes: small C kernels, each as one inline loop and most also as a transition plus wrapper
const dir = outputDirectory();
const sources = `${cases}/redteam`;
mkdirSync(`${dir}/clang`, { recursive: true });

// [id, note, also built as a transition plus wrapper]
const kernels: [string, string, boolean][] = [
	['crc32c', 'bitwise CRC-32C', true],
	['crc32', 'bitwise CRC-32', true],
	['crc16', 'CRC-16 in a 32-bit word', true],
	['crc32-msb', 'MSB-first CRC-32', true],
	['xorshift', 'xorshift mix', true],
	['xorbyte', 'xor of bytes', true],
	['shiftxor', 's = s<<1 ^ b', true],
	['rotl5', 'rotate hash', true],
	['sar3', 'arithmetic shift mix', true],
	['nibble-crc', 'table-driven nibble CRC', true],
	['poly31', 's*31+b (z2w)', true],
	['sum', 'byte sum (z2w)', true],
	['fnv1a', 'FNV-1a', true],
	['andmix', 'and of state and byte', true],
	['shlvar', 'shift by state bits', true],
	['parity', 'popcount parity mix (linear, popcnt)', true],
	['clamp', 'saturating', true],
	['mulbyte', 'multiply by byte', true],
	['neg-mask', 'negate a 2-bit field', true],
	['crc32-std', 'CRC-32 with init and final complement', false],
	['cond-mismatch', 'pre complement, no post', false],
	['cond-const-diff', 'pre complement, post xor 0x55', false],
	['cond-rot', 'pre rotate, post rotate back', false],
	['cond-final-only', 'final xor only', false]
];

// loop-only kernels
const custom: [string, string][] = [
	['pos-parity', 'byte xor index parity'],
	['addr-parity', 'byte xor address parity'],
	['len-mix', 'length mixed in'],
	['len-trigger', 'bit flipped when one call has 1000 bytes'],
	['len-large', 'bit flipped when one call has over 65536 bytes'],
	['early-zero', 'stops at a zero byte'],
	['words4', 'xor of 32-bit words then tail bytes'],
	['unroll2', 'two bytes per step with tail'],
	['two-pass', 'two passes over the input'],
	['minmax', 'running maximum'],
	['prev-byte', 'uses the previous byte'],
	['count-down-ptr', 'pointer loop'],
	['do-while', 'do-while with a guard'],
	['signed-byte', 'signed char'],
	['stride2', 'reads every second byte']
];

const flags = ['-O0', '-O1', '-O2', '-O3', '-Os'];
const entries: Entry[] = [];
const compile = (name: string, form: 'stream' | 'loop', note: string, exportsList: string) => {
	const file = `${sources}/${name}.c`;
	const src = readFileSync(file, 'utf8');
	const id = name.replace(/-(loop|stream)$/, '');
	for (const opt of flags) {
		const out = `${dir}/clang/${name}-${opt.slice(1)}.wasm`;
		try {
			execFileSync(
				clang,
				[
					'--target=wasm32',
					opt,
					'-g0',
					'-ffreestanding',
					'-fno-builtin',
					'-nostdlib',
					file,
					'-o',
					out,
					`-Wl,--no-entry,--export-memory,${exportsList},--initial-memory=2097152,--max-memory=536870912`
				],
				{ env, stdio: 'pipe' }
			);
		} catch (e) {
			console.log('compile failed', name, opt, String((e as any).stderr ?? e).slice(0, 200));
			continue;
		}
		entries.push({
			id: `c/${id}/${opt.slice(1)}/${form}`,
			group: 'compiled',
			note: `${note} ${opt}`,
			source: src,
			bytes: new Uint8Array(readFileSync(out))
		});
	}
};
for (const [id, note, stream] of kernels) {
	compile(`${id}-loop`, 'loop', `${note} inline`, '--export=update');
	if (stream)
		compile(`${id}-stream`, 'stream', `${note} wrapper`, '--export=update,--export=transition');
}
for (const [id, note] of custom) compile(`${id}-loop`, 'loop', note, '--export=update');
runBatch(entries, dir, 'c');
