import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const compiled = JSON.parse(await readFile(new URL('./compiled.json', import.meta.url), 'utf8'));
const base = JSON.parse(await readFile(new URL('./raw.json', import.meta.url), 'utf8'));
const original = new WebAssembly.Module(new Uint8Array(await readFile(join(compiled.directory, 'guest.wasm'))));
const overlays = await Promise.all((await readdir(compiled.directory)).filter((name: string) => name.startsWith('overlay-'))
	.map(async (name: string) => ({ path: join(compiled.directory, name), names: await readdir(join(compiled.directory, name)) })));
const rows: object[] = [];
for (const row of compiled.rows.filter((r: any) => r.logicalMiB <= 512)) {
	const candidates = overlays.filter(item => item.names.length === row.dirtyPagesVerified);
	assert.equal(candidates.length, 1);
	const overlay = candidates[0]!;
	const worker = new Worker(new URL('./native-worker.ts', import.meta.url), {
		workerData: { module: original, pages: row.logicalMiB * 16, overlay: overlay.path,
			backing: join(base.directory, 'pages.bin'), dirty: overlay.names.map(name => Number(name.slice(5))), expected: row.expected }
	});
	let result: any;
	try { result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); }
	finally { await worker.terminate(); }
	rows.push({ logicalMiB: row.logicalMiB, ...result }); console.log(JSON.stringify(rows.at(-1)));
}
await writeFile(new URL('./native.json', import.meta.url), JSON.stringify({ kind: 'unmodified-native-c-vs-elastic-full-memory', rows }, null, 2) + '\n');
