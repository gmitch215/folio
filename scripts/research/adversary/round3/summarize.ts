import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outDir, resultDir, type Row } from './lib.ts';

// usage: summarize.ts [manifest]; counts the rows of results/shard-*.jsonl and results/extra-*.jsonl
// (the last row of an id wins), prints every wrong acceptance, and with `manifest` writes modules.json
const rows: Row[] = [];
for (const f of readdirSync(resultDir))
	if (/^(shard|extra)-.*\.jsonl$/.test(f))
		for (const line of readFileSync(join(resultDir, f), 'utf8').split('\n'))
			if (line) rows.push(JSON.parse(line));
const byId = new Map<string, Row>();
for (const r of rows) byId.set(r.id, r);
const all = [...byId.values()];
const shas = new Set(all.filter((r) => r.sha256).map((r) => r.sha256));
const tally: Record<string, number> = {};
const fam: Record<string, Record<string, number>> = {};
for (const r of all) {
	tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
	const k = r.family.replace(/^(mu)-.*/, '$1');
	fam[k] ??= {};
	fam[k]![r.verdict] = (fam[k]![r.verdict] ?? 0) + 1;
}
console.log('modules tried', all.length, 'distinct sha', shas.size);
console.log(JSON.stringify(tally));
for (const [k, v] of Object.entries(fam).sort()) console.log(k.padEnd(12), JSON.stringify(v));
const acc = all.filter((r) => r.verdict.startsWith('accepted') || r.verdict === 'ACCEPTED-WRONG');
console.log('accepted distinct sha', new Set(acc.map((r) => r.sha256)).size);
const rings: Record<string, number> = {};
for (const r of acc) {
	const k = `${r.ring}${r.output ? '+out' : ''}`;
	rings[k] = (rings[k] ?? 0) + 1;
}
console.log('acceptances by ring', JSON.stringify(rings));
const wrong = all.filter((x) => x.verdict === 'ACCEPTED-WRONG');
for (const r of wrong) console.log('WRONG', r.id, r.sha256.slice(0, 12), r.ground, r.ground2);
for (const r of all
	.filter((x) => x.verdict === 'harness-error' || x.verdict === 'build-error')
	.slice(0, 25))
	console.log(r.verdict, r.id, r.reason);
if (process.argv[2] === 'manifest') {
	const manifest = all.map((r) => ({
		id: r.id,
		family: r.family,
		sha256: r.sha256,
		verdict: r.verdict,
		ring: r.ring,
		output: r.output,
		modulus: r.modulus,
		reason: r.reason,
		groundTruth:
			r.verdict === 'refused' || r.verdict === 'refused-valid'
				? `composes: ${r.composes === '' ? 'yes' : r.composes}; hand-model: ${r.ground ?? 'n/a'}`
				: `${r.ground || 'ok'} / ${r.ground2 || 'ok'}`
	}));
	writeFileSync(join(outDir, 'modules.json'), JSON.stringify(manifest, null, 1));
	console.log('manifest', manifest.length);
}
process.exit(wrong.length ? 1 : 0);
