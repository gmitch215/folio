import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Manifest, here } from './gen-lib.ts';

// control: the unmodified accepted subjects, plus the three refused ones, through the same harness
const dir = 'build/research/affine';
const m = new Manifest('control');
const names: [string, string][] = [
	['crc32c', 'crc32c'],
	['crc16', 'crc16'],
	['crc64', 'crc64'],
	['poly31', 'poly31'],
	['lcg', 'lcg'],
	['adler32', 'adler32'],
	['miniz-crc32', 'mz_crc32'],
	['xlcg', 'xlcg'],
	['xshift', 'xshift'],
	['xsbox', 'xsbox'],
	['xfeed', 'xfeed'],
	['fnv1a', 'fnv1a'],
	['sha256c', 'sha256c'],
	['miniz-adler32', 'mz_adler32']
];
for (const [n, entry] of names)
	m.add('control', `control/${n}`, new Uint8Array(readFileSync(join(dir, `${n}.wasm`))), { entry });
console.log(m.count, 'control modules', here);
