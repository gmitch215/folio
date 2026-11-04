import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../../../src/certify.ts';
import { modDir, outDir } from './lib.ts';

// recertifies every distinct module of a manifest with the current checker
//   recert.ts SHARD SHARDS OUTPUT.json [MANIFEST.json]   one shard; the manifest defaults to modules.json
//   recert.ts merge OUTPUT.json...                        counts the verdict transitions of the shards
// the modules come from the output directory; exits 1 when a wrong acceptance is still accepted
interface Row {
	id: string;
	sha: string;
	was: string;
	now: string;
	ms?: number;
	reason?: string;
}

if (process.argv[2] === 'merge') {
	const rows = process.argv.slice(3).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as Row[]);
	const table: Record<string, number> = {};
	for (const r of rows) table[`${r.was} -> ${r.now}`] = (table[`${r.was} -> ${r.now}`] ?? 0) + 1;
	console.log(`${rows.length} distinct modules`);
	for (const [k, v] of Object.entries(table).sort()) console.log(String(v).padStart(5), k);
	const stillWrong = rows.filter((r) => r.was === 'ACCEPTED-WRONG' && r.now === 'accepted');
	for (const r of stillWrong) console.log('STILL ACCEPTED', r.id);
	process.exit(stillWrong.length ? 1 : 0);
}

const [shard, shards, out, manifest] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(manifest ?? join(outDir, 'modules.json'), 'utf8')) as {
	id: string;
	sha256: string;
	verdict: string;
}[];
const seen = new Set<string>();
const result: Row[] = [];
let i = 0;
for (const r of rows) {
	if (seen.has(r.sha256)) continue;
	seen.add(r.sha256);
	if (i++ % Number(shards) !== Number(shard)) continue;
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(join(modDir, `${r.sha256.slice(0, 16)}.wasm`)));
	} catch {
		result.push({ id: r.id, sha: r.sha256, was: r.verdict, now: 'missing' });
		continue;
	}
	let entry = 'update';
	try {
		const exports = Object.entries(
			new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {}).exports
		);
		if (!exports.some(([k]) => k === 'update'))
			entry = exports.find(([, v]) => typeof v === 'function')?.[0] ?? 'update';
	} catch {
		// modules that need imports are refused by the checker
	}
	const t = Date.now();
	const c = certifyStream(bytes, entry, { maxMs: 20000 });
	result.push({
		id: r.id,
		sha: r.sha256,
		was: r.verdict,
		now: c.kind === 'certificate' ? 'accepted' : 'refused',
		ms: Date.now() - t,
		reason: c.kind === 'refusal' ? c.reason.slice(0, 120) : undefined
	});
}
writeFileSync(out!, JSON.stringify(result));
console.log(`shard ${shard} done ${result.length}`);
