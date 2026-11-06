import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('.', import.meta.url);
const directory = new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', root);
const destination = new URL('./source/', directory);
await mkdir(destination, { recursive: true });
const files = [];
for (const name of ['worker.mjs', 'run.ts']) {
	const bytes = await readFile(new URL(name, root));
	await copyFile(new URL(name, root), new URL(name, destination));
	files.push({
		path: name,
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex')
	});
}
const fixtureSource = new URL(
	'../../results/execution/elastic-memory/managed-envelope/source/fixture.wasm',
	root
);
const fixture = await readFile(fixtureSource);
await copyFile(fixtureSource, new URL('./fixture.wasm', destination));
files.push({
	path: 'fixture.wasm',
	bytes: fixture.length,
	sha256: createHash('sha256').update(fixture).digest('hex')
});
await writeFile(
	new URL('./sources.json', destination),
	JSON.stringify({ frozenAt: new Date().toISOString(), files }, null, 2) + '\n',
	{ flag: 'wx' }
);
console.log(JSON.stringify({ files: files.length }));
