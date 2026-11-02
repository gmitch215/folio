import binaryen from 'binaryen';
import { performance } from 'node:perf_hooks';
import { prepare } from '../../src/compiler.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';

const partitionWords = 4096;
const base = 65536;
const waves = 3;

function kernelSource(pages: number): Uint8Array {
	const call = (index: number) =>
		`(call $run (i32.add (local.get $base) (i32.const ${index * partitionWords * 4})) (i32.const ${partitionWords}) (i32.const 2))`;
	const module = binaryen.parseText(`(module (memory (export "memory") ${pages} ${pages} shared)
	(func $run (param $offset i32) (param $words i32) (param $rounds i32)
		(local $i i32) (local $r i32) (local $x i32) (local $addr i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $words)))
			(local.set $addr (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 2))))
			(local.set $x (i32.load (local.get $addr)))
			(local.set $r (i32.const 0))
			(block $end (loop $round
				(br_if $end (i32.ge_u (local.get $r) (local.get $rounds)))
				(local.set $x (i32.xor
					(i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223))
					(i32.shr_u (local.get $x) (i32.const 15))))
				(local.set $r (i32.add (local.get $r) (i32.const 1)))
				(br $round)))
			(i32.store (local.get $addr) (local.get $x))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each))))
	(func (export "main") (param $base i32) (param $waves i32) (result i32)
		(local $wave i32) (local $sum i32)
		(loop $next
			${[0, 1, 2, 3].map(call).join(' ')}
			(local.set $sum (i32.add (local.get $sum) (i32.load (local.get $base))))
			(local.set $wave (i32.add (local.get $wave) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $wave) (local.get $waves))))
		(local.get $sum)))`);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

function artifact(bytes: Uint8Array): ManagedArtifact {
	const plan = prepare(bytes, { minimumRegionWork: 0 }).control;
	if (!plan) throw new Error('no control plan');
	const { coordinator, transactional, workerOriginal: _, ...control } = plan;
	return {
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		coordinator: new WebAssembly.Module(Uint8Array.from(coordinator)),
		transactional: new WebAssembly.Module(Uint8Array.from(transactional)),
		control,
		memories: memoryImports(bytes)
	};
}

function seed(bytes: Uint8Array) {
	bytes.fill(0);
	const view = new Uint32Array(bytes.buffer, base, partitionWords * 4);
	let state = 12345;
	for (let i = 0; i < view.length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		view[i] = state;
	}
}

// in-process lanes behind a transport that copies both ways; a deployed transport replaces this
function transports(program: ManagedArtifact, count: number, requests: { n: number }) {
	return Array.from({ length: count }, (): ManagedLaneTransport => {
		const lane = new FolioLane(program.transactional!, {
			initial: program.control!.initial,
			maximum: program.control!.maximum
		});
		return {
			execute: async (frame) => {
				requests.n++;
				return new Uint8Array(lane.execute(new Uint8Array(frame)));
			},
			close: async () => lane.close()
		};
	});
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
const arenas = [128 * 1024, 1048576, 8 * 1048576, 32 * 1048576];
const repeats = Number(process.argv[2] ?? 5);

if (import.meta.main) {
	console.log(
		'arena_KiB mode      exact sent_B       received_B   requests rangeB      escapeRounds fallbacks(snap/serial/transport) wall_ms(median)'
	);
	for (const arena of arenas) {
		const program = artifact(kernelSource(arena / 65536));
		const instance = new WebAssembly.Instance(program.original, {});
		const reference = instance.exports.memory as WebAssembly.Memory;
		seed(new Uint8Array(reference.buffer));
		const value = (instance.exports.main as CallableFunction)(base, waves);
		for (const mode of ['snapshot', 'ranges'] as const) {
			const requests = { n: 0 };
			const pool = new ManagedFolio(program, {
				lanes: transports(program, 4, requests),
				...(mode === 'ranges' ? { ranges: {} } : {})
			});
			try {
				const walls: number[] = [];
				let last, first;
				for (let i = 0; i < repeats; i++) {
					seed(new Uint8Array(pool.memory.buffer));
					requests.n = 0;
					const start = performance.now();
					last = await pool.run('main', [base, waves]);
					walls.push(performance.now() - start);
					first ??= last;
				}
				const exact =
					last!.values[0] === value &&
					Buffer.compare(
						new Uint8Array(pool.memory.buffer),
						new Uint8Array(reference.buffer)
					) === 0;
				const row = {
					arenaKiB: arena / 1024,
					mode,
					exact,
					coldSent: first!.transportBytes.sent,
					coldEscapeRounds: first!.escapeRounds ?? 0,
					sent: last!.transportBytes.sent,
					received: last!.transportBytes.received,
					requests: requests.n,
					rangeBytes: last!.rangeBytes ?? 0,
					escapeRounds: last!.escapeRounds ?? 0,
					fallbacks: [
						last!.rangeFallbacks?.snapshot ?? 0,
						last!.rangeFallbacks?.serial ?? 0,
						last!.transportFallbacks
					],
					wallMs: Number(median(walls).toFixed(2)),
					wallRangeMs: [Math.min(...walls), Math.max(...walls)].map((v) =>
						Number(v.toFixed(2))
					),
					coldWallMs: Number(walls[0]!.toFixed(2)),
					diagnostic: pool.diagnostics[0]
				};
				console.log(
					[
						String(row.arenaKiB).padEnd(9),
						mode.padEnd(9),
						String(exact).padEnd(5),
						String(row.sent).padEnd(12),
						String(row.received).padEnd(12),
						String(row.requests).padEnd(8),
						String(row.rangeBytes).padEnd(11),
						String(row.escapeRounds).padEnd(12),
						row.fallbacks.join('/').padEnd(34),
						row.wallMs
					].join(' ')
				);
				console.log('  ' + JSON.stringify(row));
			} finally {
				await pool.close();
			}
		}
	}
}
