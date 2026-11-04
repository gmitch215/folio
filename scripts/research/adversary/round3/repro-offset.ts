import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../../../src/certify.ts';
import { sha256 } from '../lib.ts';
import { buildWat, outDir } from './lib.ts';

// two modules whose entry traps. wasm adds the offset immediate to the address without wrapping and
// the old checker wrapped it, so it accepted both; writes repro-offset-*.wasm and .wat to the output
// directory and exits 1 when the checker accepts either
const body = (
	load: string
) => `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $i i32)
 (block $done (loop $l
  (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
  (local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31)) ${load}))
  (local.set $i (i32.add (local.get $i) (i32.const 1)))
  (br $l)))
 (local.get $s))`;
const base = `(i32.add (local.get $p) (local.get $i))`;
const cases: Record<string, { wat: string; pointer: number; why: string }> = {
	// base is p + i + 1 and the immediate is 2^32 - 1, so the checker saw p + i and wasm sees p + i + 2^32
	wrap: {
		wat: body(`(i32.load8_u offset=4294967295 (i32.add ${base} (i32.const 1)))`),
		pointer: 1 << 20,
		why: 'every call traps, at any pointer'
	},
	// base is p + i - 1 and the immediate is 1: wasm traps when p + i = 0 because p + i - 1 wraps to
	// 2^32 - 1 and the effective address becomes 2^32
	negative: {
		wat: body(`(i32.load8_u offset=1 (i32.sub ${base} (i32.const 1)))`),
		pointer: 0,
		why: 'traps at pointer 0, which is inside memory and clear of every exclusion'
	}
};
mkdirSync(outDir, { recursive: true });
let accepted = 0;
for (const [name, c] of Object.entries(cases)) {
	const bytes = buildWat(c.wat);
	writeFileSync(join(outDir, `repro-offset-${name}.wasm`), bytes);
	writeFileSync(
		join(outDir, `repro-offset-${name}.wat`),
		`(module (memory (export "memory") 32 512) ${c.wat})\n`
	);
	const cert = certifyStream(bytes, 'update');
	if (cert.kind === 'certificate') accepted++;
	console.log(
		name,
		sha256(bytes).slice(0, 12),
		cert.kind,
		cert.kind === 'certificate' ? cert.ring : cert.reason
	);
	const fn = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {}).exports
		.update as (a: number, b: number, c: number) => number;
	try {
		console.log('  update(0,', c.pointer, ', 1) =', fn(0, c.pointer, 1));
	} catch (e) {
		console.log('  update(0,', c.pointer, ', 1) throws', String(e).slice(0, 60), '-', c.why);
	}
	console.log(
		'  exclusions',
		cert.kind === 'certificate' ? JSON.stringify(cert.exclusions) : '-'
	);
}
process.exit(accepted ? 1 : 0);
