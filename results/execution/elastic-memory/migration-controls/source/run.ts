import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { touchedPage } from './access.ts';

const PAGE = 65536;
const study = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/capacity-local'
);
const directory = await mkdtemp(join(tmpdir(), 'folio-elastic-'));
const backing = join(directory, 'pages.bin');
const maxPages = 32768;
const file = await open(backing, 'wx');
const words = new Int32Array(maxPages),
	links = new Uint32Array(maxPages),
	zero = Buffer.alloc(PAGE),
	key = Buffer.alloc(16, 31);
const hash = createHash('sha256');
for (let page = 0; page < maxPages; page++) {
	const iv = Buffer.alloc(16);
	iv.writeUInt32LE(page);
	const data = createCipheriv('aes-128-ctr', key, iv).update(zero);
	words[page] = data.readInt32LE(128);
	links[page] = data.readUInt32LE(132);
	hash.update(data);
	assert.equal((await file.write(data, 0, PAGE, page * PAGE)).bytesWritten, PAGE);
}
await file.close();
console.log('2 GiB dense deterministic backing completed');
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
function build(elastic: boolean, mutable = false) {
	const read = elastic
		? `(local.set $slot (i32.const 0))
		(block $found (loop $lookup
			(br_if $found (i32.eq (i32.load (i32.add (i32.const 16384) (i32.mul (local.get $slot) (i32.const 4)))) (local.get $p)))
			(local.set $slot (i32.add (local.get $slot) (i32.const 1)))
			(br_if $lookup (i32.lt_u (local.get $slot) (i32.const 4)))
			(local.set $slot (call $fault (local.get $p) (i32.const 0)))))`
		: `(if (i32.eqz (i32.load8_u (i32.add (i32.const 16384) (local.get $p))))
			(then (drop (call $fault (local.get $p) (i32.const 0)))))`;
	const m = binaryen.parseText(`(module
		(import "env" "memory" (memory 1 65536))
		(import "host" "fault" (func $fault (param i32 i32) (result i32)))
		(import "host" "park" (func $park))
		(func $read (param $p i32) (result i32) (local $slot i32)
			${read}
			(i32.load offset=128 (i32.mul (i32.add (local.get ${elastic ? '$slot' : '$p'}) (i32.const 1)) (i32.const 65536))))
		${
			mutable
				? `(func $mutate (param $p i32) (param $value i32) (result i32) (local $slot i32)
			${read}
			(i32.store offset=128 (i32.mul (i32.add (local.get $slot) (i32.const 1)) (i32.const 65536)) (local.get $value))
			(i32.store8 (i32.add (i32.const 17000) (local.get $slot)) (i32.const 1))
			(i32.load offset=132 (i32.mul (i32.add (local.get $slot) (i32.const 1)) (i32.const 65536))))`
				: ''
		}
		(func (export "run") (param $pages i32) (param $working i32) (param $n i32) (param $receiver i32) (result i32)
			(local $i i32) (local $s i32) (local $p i32) (local $value i32) (local $w i32)
			(block $end (loop $again
				(br_if $end (i32.ge_u (local.get $i) (local.get $n)))
				(if (i32.eq (local.get $i) (i32.div_u (local.get $n) (i32.const 2))) (then (call $park)))
				${mutable ? '' : '(local.set $w (select (local.get $working) (local.get $receiver) (i32.lt_u (local.get $i) (i32.div_u (local.get $n) (i32.const 2)))))(local.set $p (i32.mul (i32.rem_u (local.get $i) (local.get $w)) (i32.div_u (local.get $pages) (local.get $w))))'}
				(local.set $value (call $read (local.get $p)))
				(local.set $s (i32.xor (i32.mul (local.get $s) (i32.const 31)) (local.get $value)))
				${mutable ? '(local.set $p (i32.rem_u (call $mutate (local.get $p) (i32.add (local.get $value) (i32.const 1))) (local.get $pages)))' : ''}
				(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
			(local.get $s)))`);
	m.setFeatures(binaryen.Features.All & ~compact);
	binaryen.setPassArgument('asyncify-imports', 'host.fault,host.park');
	m.runPasses(['asyncify']);
	binaryen.setPassArgument('asyncify-imports', null);
	const bytes = Uint8Array.from(m.emitBinary());
	m.dispose();
	return { bytes, module: new WebAssembly.Module(bytes) };
}
const compiled = { elastic: build(true), mutable: build(true, true), full: build(false) };
const rows: any[] = [];
type Spec = { mode: string; mib: number; working: number; receiver?: number; iterations: number };
const specs: Spec[] = [
	...[192, 512, 1024, 2048].map((mib) => ({
		mode: 'elastic',
		mib,
		working: 4,
		iterations: 4096
	})),
	...['eager', 'postcopy', 'prefetch'].flatMap((mode) =>
		[192, 512].map((mib) => ({ mode, mib, working: 4, iterations: 4096 }))
	),
	...['elastic', 'postcopy', 'prefetch'].map((mode) => ({
		mode,
		mib: 512,
		working: 128,
		iterations: 512
	})),
	...[512, 2048].map((mib) => ({ mode: 'elastic-write', mib, working: 128, iterations: 512 }))
];
if (process.env.FOLIO_ELASTIC_FULL_SCAN === '1')
	specs.splice(0, specs.length, {
		mode: 'elastic',
		mib: 2048,
		working: 32768,
		iterations: 32768
	});
if (process.env.FOLIO_ELASTIC_MATRIX === 'touched')
	specs.splice(
		0,
		specs.length,
		...[1, 2, 4].flatMap((receiver) =>
			['eager', 'postcopy', 'prefetch', 'elastic', 'elastic-lazy'].map((mode) => ({
				mode,
				mib: 512,
				working: 4,
				receiver,
				iterations: 4096
			}))
		)
	);
const outputPath = resolve(process.env.FOLIO_ELASTIC_OUTPUT ?? join(study, 'raw.json'));
for (const spec of specs) {
	const pages = spec.mib * 16;
	const receiver = spec.receiver ?? spec.working;
	const module =
		compiled[
			spec.mode === 'elastic-write' ? 'mutable' : spec.mode.startsWith('elastic') ? 'elastic' : 'full'
		].module;
	const overlay = await mkdtemp(join(directory, 'overlay-'));
	const profile = Array.from(
		{ length: spec.working },
		(_, k) => k * Math.floor(pages / spec.working)
	);
	let image: Uint8Array | undefined, value: number | undefined;
	const segments: any[] = [];
	const started = performance.now();
	let checkpointBytes = 0;
	while (value === undefined) {
		const worker = new Worker(new URL('./worker.ts', import.meta.url), {
			workerData: { ...spec, receiver, pages, module, backing, image, profile, overlay },
			transferList: image ? [image.buffer as ArrayBuffer] : [],
			resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 }
		});
		let message: any;
		try {
			message = await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
				worker.once('exit', (code) => {
					if (code) reject(new Error(`worker exited ${code}`));
				});
			});
		} finally {
			await worker.terminate();
		}
		const { image: next, ...metrics } = message;
		segments.push(metrics);
		if (message.kind === 'done') value = message.value;
		else {
			image = next;
			checkpointBytes += image!.byteLength;
		}
	}
	let expected = 0,
		cursor = 0;
	const visits = new Map<number, number>();
	for (let i = 0; i < spec.iterations; i++) {
		const page =
			spec.mode === 'elastic-write'
				? cursor
				: touchedPage(i, spec.iterations, spec.working, receiver, pages);
		const count = visits.get(page) ?? 0;
		const value = spec.mode === 'elastic-write' ? (words[page]! + count) | 0 : words[page]!;
		expected = Math.imul(expected, 31) ^ value;
		visits.set(page, count + 1);
		cursor = links[page]! % pages;
	}
	assert.equal(value, expected);
	if (spec.mode === 'elastic-write') {
		const actualNames = await readdir(overlay);
		assert.equal(actualNames.length, visits.size);
		for (const [page, count] of visits) {
			const actual = await readFile(join(overlay, `page-${page}`));
			const iv = Buffer.alloc(16);
			iv.writeUInt32LE(page);
			const expectedPage = createCipheriv('aes-128-ctr', key, iv).update(zero);
			expectedPage.writeInt32LE((words[page]! + count) | 0, 128);
			assert.ok(actual.equals(expectedPage), `dirty page ${page}`);
		}
	}
	assert.equal(segments.length, 2);
	const fetchBytes = segments.reduce((sum, s) => sum + s.stats.fetchBytes, 0);
	const writebackBytes = segments.reduce((sum, s) => sum + s.stats.writebackBytes, 0);
	const row = {
		receiver,
		...spec,
		value,
		expected,
		exact: true,
		dirtyPagesVerified: spec.mode === 'elastic-write' ? visits.size : 0,
		checkpointBytes,
		fetchBytes,
		writebackBytes,
		totalPayloadBytes: checkpointBytes + fetchBytes + writebackBytes,
		wallMs: performance.now() - started,
		segments,
		sampledHeapMax: Math.max(
			...segments.flatMap((s) => s.stats.samples.map((m: any) => m.heapUsed))
		),
		sampledArrayBufferMax: Math.max(
			...segments.flatMap((s) => s.stats.samples.map((m: any) => m.arrayBuffers))
		)
	};
	rows.push(row);
	console.log(JSON.stringify({ ...row, segments: segments.length }));
	await writeFile(outputPath, JSON.stringify({ rows, directory: '<scratch>' }, null, 2) + '\n');
}
const names = ['run.ts', 'worker.ts', 'access.ts'];
const sources = await Promise.all(
	names.map(async (path) => {
		const bytes = await readFile(new URL(path, import.meta.url));
		return {
			path,
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	})
);
await writeFile(
	outputPath,
	JSON.stringify(
		{
			node: process.version,
			cpu: cpus()[0]?.model,
			loadavg: loadavg(),
			backingBytes: maxPages * PAGE,
			backingSha256: hash.digest('hex'),
			directory: '<scratch>',
			sources,
			modules: Object.fromEntries(
				Object.entries(compiled).map(([name, item]) => [
					name,
					createHash('sha256').update(item.bytes).digest('hex')
				])
			),
			rows,
			limitations: [
				'local Node isolates; process RSS is shared and not an isolate meter',
				'eager/post-copy/prefetch controls model mechanisms; not reproductions of published systems',
				'read-only controls and mutable pointer chase with four resident software frames; one local session',
					'round-robin eviction (load order, FIFO); the LRU arm is in sweep.ts',
				'peak samples are observed values, not a complete peak proof',
				'payload counts exclude RPC headers and filesystem protocol overhead'
			]
		},
		null,
		2
	) + '\n'
);
