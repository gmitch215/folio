import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../lib.ts';
import { buildSpec, modDir, outDir } from './lib.ts';
import { allSpecs } from './specs.ts';

// usage: digests.ts [REFERENCE.json]; builds every spec without certifying it, writes the modules and
// digests.json, and compares with the id and sha256 rows of a reference manifest; exits 1 on a difference
const reference = process.argv[2];
mkdirSync(modDir, { recursive: true });
const rows: { id: string; sha256: string; error?: string }[] = [];
for (const spec of allSpecs()) {
	try {
		const bytes = buildSpec(spec);
		const digest = sha256(bytes);
		writeFileSync(join(modDir, `${digest.slice(0, 16)}.wasm`), bytes);
		rows.push({ id: spec.id, sha256: digest });
	} catch (e) {
		rows.push({ id: spec.id, sha256: '', error: String((e as Error).message).slice(0, 120) });
	}
}
writeFileSync(join(outDir, 'digests.json'), JSON.stringify(rows));
const distinct = new Set(rows.filter((r) => r.sha256).map((r) => r.sha256));
console.log(`built ${rows.length} specs, ${distinct.size} distinct modules`);
if (!reference) process.exit(0);

const want = new Map<string, string>(
	(JSON.parse(readFileSync(reference, 'utf8')) as { id: string; sha256: string }[]).map((r) => [
		r.id,
		r.sha256
	])
);
const got = new Map(rows.map((r) => [r.id, r.sha256]));
let equal = 0;
const different: string[] = [];
const missing = [...want.keys()].filter((id) => !got.has(id));
const extra = [...got.keys()].filter((id) => !want.has(id));
for (const [id, digest] of got)
	if (want.has(id)) {
		if (want.get(id) === digest) equal++;
		else different.push(id);
	}
console.log(
	`equal ${equal}, different ${different.length}, missing ${missing.length}, extra ${extra.length}`
);
for (const id of different.slice(0, 20)) console.log('different', id);
for (const id of missing.slice(0, 20)) console.log('missing', id);
for (const id of extra.slice(0, 20)) console.log('extra', id);
process.exit(different.length || missing.length || extra.length ? 1 : 0);
