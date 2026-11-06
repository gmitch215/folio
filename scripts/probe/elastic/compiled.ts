import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { clang, env } from '../../../scripts/research/affine-build.ts';
import { prepare } from '../../../src/compiler.ts';

const study = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/capacity-local'
);
const old = JSON.parse(await readFile(join(study, 'raw.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'folio-elastic-c-'));
const path = join(directory, 'guest.wasm');
execFileSync(
	clang,
	[
		'--target=wasm32',
		'-O2',
		'-g0',
		'-ffreestanding',
		'-fno-builtin',
		'-nostdlib',
		'-matomics',
		'-mbulk-memory',
		new URL('./guest.c', import.meta.url).pathname,
		'-o',
		path,
		'-Wl,--no-entry,--export=walk,--import-memory,--shared-memory,--initial-memory=131072,--max-memory=4294967296'
	],
	{ env }
);
const original = new Uint8Array(await readFile(path));
const prepared = prepare(original, { minimumRegionWork: 0 });
assert.ok(prepared.transactional, prepared.reasons.join('; '));
const raw = binaryen.readBinary(prepared.transactional!);
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
raw.setFeatures(binaryen.Features.All & ~compact);
const text = raw.emitText();
raw.dispose();
assert.equal((text.match(/ shared\)/g) ?? []).length, 1);
const transformed = binaryen.parseText(text.replace(' shared)', ')'));
transformed.setFeatures(binaryen.Features.All & ~compact);
binaryen.setPassArgument('asyncify-imports', 'folio.load,folio.store,folio.exhausted');
transformed.runPasses(['asyncify']);
binaryen.setPassArgument('asyncify-imports', null);
const binary = Uint8Array.from(transformed.emitBinary());
transformed.dispose();
await writeFile(join(directory, 'elastic.wasm'), binary);
const module = new WebAssembly.Module(binary);
const rows: object[] = [];
for (const mib of [192, 512, 2048]) {
	const pages = mib * 16,
		iterations = 1024;
	const overlay = await mkdtemp(join(directory, 'overlay-'));
	let image: Uint8Array | undefined,
		value: number | undefined,
		checkpointBytes = 0;
	const segments: any[] = [];
	while (value === undefined) {
		const worker = new Worker(new URL('./c-worker.ts', import.meta.url), {
			workerData: {
				module,
				pages,
				iterations,
				overlay,
				image,
				backing: join(old.directory, 'pages.bin')
			},
			transferList: image ? [image.buffer as ArrayBuffer] : [],
			resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 }
		});
		let message: any;
		try {
			message = await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
		} finally {
			await worker.terminate();
		}
		segments.push(message.stats);
		if (message.kind === 'done') value = message.value >>> 0;
		else {
			image = message.image;
			checkpointBytes += image!.length;
		}
	}
	let expected = 0,
		cursor = 0;
	const visits = new Map<number, number>(),
		basePages = new Map<number, Buffer>();
	for (let i = 0; i < iterations; i++) {
		let page = basePages.get(cursor);
		if (!page) {
			const iv = Buffer.alloc(16);
			iv.writeUInt32LE(cursor);
			page = createCipheriv('aes-128-ctr', Buffer.alloc(16, 31), iv).update(
				Buffer.alloc(65536)
			);
			basePages.set(cursor, page);
		}
		const count = visits.get(cursor) ?? 0;
		expected = (Math.imul(expected, 31) ^ ((page.readInt32LE(128) + count) | 0)) >>> 0;
		visits.set(cursor, count + 1);
		cursor = page.readUInt32LE(132) % pages;
	}
	assert.equal(value, expected);
	assert.equal((await readdir(overlay)).length, visits.size);
	for (const [index, count] of visits) {
		const expectedPage = Buffer.from(basePages.get(index)!);
		expectedPage.writeInt32LE((expectedPage.readInt32LE(128) + count) | 0, 128);
		assert.ok((await readFile(join(overlay, `page-${index}`))).equals(expectedPage));
	}
	const row = {
		logicalMiB: mib,
		exact: true,
		value,
		expected,
		originalBytes: original.length,
		transformedBytes: binary.length,
		freshExecutorIsolates: segments.length,
		checkpointBytes,
		dirtyPagesVerified: visits.size,
		segments
	};
	rows.push(row);
	console.log(JSON.stringify({ ...row, segments: segments.length }));
}
await writeFile(
	join(study, 'compiled.json'),
	JSON.stringify(
		{
			node: process.version,
			directory,
			originalSha256: createHash('sha256').update(original).digest('hex'),
			transformedSha256: createHash('sha256').update(binary).digest('hex'),
			rows,
			limitations: [
				'local Node with file-backed page versions; not PHP or managed accounting',
				'actual C loads/stores lowered by existing compiler; aligned i32 tested only',
				'128KiB Wasm control memory plus four JS page frames',
				'single trusted writer; no durable execution root'
			]
		},
		null,
		2
	) + '\n'
);
