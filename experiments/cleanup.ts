import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { classesFor, createApi, credentials, isKind, retire, snapshot } from './lib/cloudflare.ts';

// recovers a run whose driver died before its own cleanup: node experiments/cleanup.ts NAME [KIND]
const name = process.argv[2] ?? '';
assert.match(name, /^cfw-folio-[a-z0-9-]+$/);
const kind = process.argv[3] ?? 'cloud';
assert.ok(isKind(kind), 'kind must be cloud, managed or browser');
const directory = new URL(`./${kind}/runs/${name}/`, import.meta.url);
const baseline = JSON.parse(await readFile(new URL('baseline.json', directory), 'utf8'));
const run = JSON.parse(await readFile(new URL('run.json', directory), 'utf8'));
assert.equal(run.name, name);
assert.ok(!baseline.scripts.includes(name));
const api = createApi(credentials());
if ((await snapshot(api)).scripts.includes(name)) await retire(api, name, classesFor[kind]);
const after = await snapshot(api);
await writeFile(new URL('after.json', directory), `${JSON.stringify(after, null, 2)}\n`, {
	flag: 'wx'
});
assert.deepEqual(after, baseline);
console.log(JSON.stringify({ name, baselineRestored: true }));
