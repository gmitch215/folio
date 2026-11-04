import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, workDir } from './lib.ts';

// usage: node summarize.ts [DIR]; joins DIR/judge/shard-*.json with the module files and writes
// DIR/modules.json and DIR/summary.json
const root = workDir(process.argv[2]);
type Row = Record<string, any>;
const rows: Row[] = [];
const rowsDir = join(root, 'judge');
for (const name of readdirSync(rowsDir).filter((n) => n.startsWith('shard-'))) {
	rows.push(...JSON.parse(readFileSync(join(rowsDir, name), 'utf8')));
}
const byId = new Map(rows.map((r) => [r.id as string, r]));

const modules: Row[] = [];
for (const [id, r] of [...byId].sort((a, b) => a[0].localeCompare(b[0]))) {
	const bytes = new Uint8Array(readFileSync(join(root, 'modules', id)));
	const family = id.split('/')[0]!;
	let verdict: string;
	if (r.status === 'harness') verdict = 'harness';
	else if (r.wrong) verdict = 'ACCEPTED-AND-WRONG';
	else if (r.status === 'accepted') verdict = 'accepted-and-correct';
	else if (r.composes) verdict = 'refused-but-composes';
	else verdict = 'refused-and-fails';
	modules.push({
		id,
		family,
		sha256: sha256(bytes),
		verdict,
		reason: r.status === 'accepted' ? '' : r.reason,
		ground: {
			composes: r.composes ?? null,
			failure: r.failure ? `${r.failure.check}: ${r.failure.detail}` : null,
			checks: r.checks,
			combos: r.combos,
			skipped: r.skipped
		}
	});
}

const count = (pred: (m: any) => boolean) => modules.filter(pred).length;
const families: Record<string, Record<string, number>> = {};
for (const m of modules) {
	families[m.family] ??= {
		tried: 0,
		accepted: 0,
		acceptedAndWrong: 0,
		refused: 0,
		refusedButComposes: 0,
		harness: 0
	};
	const f = families[m.family]!;
	f.tried!++;
	if (m.verdict === 'accepted-and-correct') f.accepted!++;
	if (m.verdict === 'ACCEPTED-AND-WRONG') {
		f.accepted!++;
		f.acceptedAndWrong!++;
	}
	if (m.verdict === 'refused-but-composes' || m.verdict === 'refused-and-fails') f.refused!++;
	if (m.verdict === 'refused-but-composes') f.refusedButComposes!++;
	if (m.verdict === 'harness') f.harness!++;
}

const refusalGroups: Record<string, { count: number; examples: string[] }> = {};
for (const m of modules) {
	if (m.verdict !== 'refused-but-composes') continue;
	const key = m.reason.replace(/[0-9]+/g, 'N').slice(0, 140);
	refusalGroups[key] ??= { count: 0, examples: [] };
	refusalGroups[key]!.count++;
	if (refusalGroups[key]!.examples.length < 4) refusalGroups[key]!.examples.push(m.id);
}

const summary = {
	tried: modules.length,
	distinctSha256: new Set(modules.map((m) => m.sha256)).size,
	accepted: count(
		(m) => m.verdict === 'accepted-and-correct' || m.verdict === 'ACCEPTED-AND-WRONG'
	),
	acceptedAndCorrect: count((m) => m.verdict === 'accepted-and-correct'),
	acceptedAndWrong: count((m) => m.verdict === 'ACCEPTED-AND-WRONG'),
	refused: count(
		(m) => m.verdict === 'refused-but-composes' || m.verdict === 'refused-and-fails'
	),
	refusedButComposes: count((m) => m.verdict === 'refused-but-composes'),
	harness: count((m) => m.verdict === 'harness'),
	families,
	refusalGroups,
	wrong: modules
		.filter((m) => m.verdict === 'ACCEPTED-AND-WRONG')
		.map((m) => ({ id: m.id, failure: m.ground.failure }))
};
writeFileSync(join(root, 'modules.json'), JSON.stringify(modules, null, 1));
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(
	JSON.stringify(
		{
			...summary,
			refusalGroups: Object.keys(refusalGroups).length,
			families: undefined,
			wrong: undefined
		},
		null,
		1
	)
);
console.log(JSON.stringify(families, null, 1));
console.log(JSON.stringify(summary.wrong, null, 1));
