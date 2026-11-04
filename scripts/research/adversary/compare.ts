import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workDir } from './lib.ts';

// usage: node compare.ts DIR STUDY; compares the digests the generators wrote under DIR/modules
// with the rows of the study file (adversary-modules.json); exits 1 on any difference
const root = workDir(process.argv[2]);
type Entry = { id: string; family: string; sha256: string };
const made = new Map<string, string>();
for (const name of ['index-clang.json', 'index-wat.json'])
	for (const e of JSON.parse(readFileSync(join(root, 'modules', name), 'utf8')) as Entry[])
		made.set(`${e.family}/${e.id}.wasm`, e.sha256);
const study = new Map(
	(JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as Entry[]).map((e) => [e.id, e.sha256])
);

const different = [...study]
	.filter(([id, sha]) => made.has(id) && made.get(id) !== sha)
	.map(([id]) => id);
const missing = [...study.keys()].filter((id) => !made.has(id));
const extra = [...made.keys()].filter((id) => !study.has(id));
const equal = study.size - different.length - missing.length;
console.log(
	JSON.stringify({
		study: study.size,
		generated: made.size,
		equal,
		different: different.length,
		missing: missing.length,
		extra: extra.length
	})
);
for (const id of different.slice(0, 20)) console.log('different', id);
for (const id of missing.slice(0, 20)) console.log('missing', id);
for (const id of extra.slice(0, 20)) console.log('extra', id);
process.exitCode = different.length || missing.length || extra.length ? 1 : 0;
