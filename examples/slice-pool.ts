import { SlicePool } from '@gmitch215/folio/slices';
import binaryen from 'binaryen';

// Fill one shared memory in place from several threads. The caller says the slices are
// independent; nothing here tracks reads or writes, and `audit` replays the slices serially.
const wasm = binaryen.parseText(`(module
	(import "env" "memory" (memory 1 8))
	(global $sp (mut i32) (i32.const 65536))
	(func (export "fill") (param $ptr i32) (param $len i32) (param $value i32) (result i32)
		(local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $len)))
			(i32.store8 (i32.add (local.get $ptr) (local.get $i)) (local.get $value))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $len)))`);
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
wasm.setFeatures(binaryen.Features.All & ~compact);
const bytes = Uint8Array.from(wasm.emitBinary());
wasm.dispose();

const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared: true });
const pool = await SlicePool.open(bytes, { memory, workers: 4 });
try {
	const base = 4096;
	const count = 40_000;
	const report = await pool.run('fill', count, (from, to) => [base + from, to - from, 7], {
		audit: true
	});
	const filled = new Uint8Array(pool.memory.buffer, base, count).every((byte) => byte === 7);
	console.log({
		slices: report.slices,
		audited: report.audited,
		filled,
		stackBase: pool.stackBase
	});
} finally {
	await pool.close();
}
