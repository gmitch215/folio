import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Row } from './lib.ts';

// reads results/*.jsonl, keeps the last row per module sha, and prints the counts RESULT.md needs
const here = dirname(fileURLToPath(import.meta.url));
const rows = new Map<string, Row>();
const fullRows = new Map<string, Row>();
const dir = join(here, 'results');
for (const f of readdirSync(dir).sort()) {
	if (!f.endsWith('.jsonl')) continue;
	for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
		if (!line) continue;
		const r = JSON.parse(line) as Row;
		if (r.id.startsWith('full/')) fullRows.set(r.id, r);
		else rows.set(r.id, r);
	}
}
const all = [...rows.values()];
const fams = [...new Set(all.map((r) => r.family))].sort();
const out: string[] = [];
const p = (s = '') => out.push(s);

p('| family | run | refused | accepted by checker | accepted by verifier | ground truth false | disagree | raw | hang |');
p('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const tot = { n: 0, ref: 0, acc: 0, ver: 0, gt: 0, dis: 0, raw: 0, hang: 0 };
for (const f of [...fams, '*']) {
	const rs = f === '*' ? all.filter((r) => r.family !== 'control') : all.filter((r) => r.family === f);
	const n = rs.length;
	const ref = rs.filter((r) => r.checker === 'refused').length;
	const acc = rs.filter((r) => r.checker === 'accepted').length;
	const ver = rs.filter((r) => r.verifier === 'accepts').length;
	const gt = rs.filter((r) => /^FALSE/.test(r.kind)).length;
	const dis = rs.filter((r) => /DISAGREE/.test(r.kind)).length;
	const raw = rs.filter((r) => /^raw/.test(r.kind)).length;
	const hang = rs.filter((r) => /HANG/.test(r.kind)).length;
	p(`| ${f === '*' ? 'all but control' : f} | ${n} | ${ref} | ${acc} | ${ver} | ${gt} | ${dis} | ${raw} | ${hang} |`);
	void tot;
}
p();
const borrowed = all.filter((r) => r.borrowed);
p(`borrowed-certificate rows: ${borrowed.length}; verifier accepts the borrowed certificate: ${borrowed.filter((r) => r.borrowed === 'verifier-accepts').length}; verifier rejects: ${borrowed.filter((r) => r.borrowed === 'verifier-rejects').length}; borrowed accept with false ground truth: ${all.filter((r) => r.kind === 'FALSE-ACCEPT-VERIFIER').length}`);
p();
p('kinds: ' + JSON.stringify(Object.fromEntries([...new Set(all.map((r) => r.kind))].map((k) => [k, all.filter((r) => r.kind === k).length]))));
p();

const key = (reason: string) => {
	const first = reason.split('; ')[0]!;
	return first.replace(/^(gfN|zNw|zp): /, '').slice(0, 100);
};
const hist = (rs: Row[]) => {
	const h = new Map<string, number>();
	for (const r of rs) h.set(key(r.reason ?? ''), (h.get(key(r.reason ?? '')) ?? 0) + 1);
	return [...h].sort((a, b) => b[1] - a[1]);
};
const refused = all.filter((r) => r.checker === 'refused' && r.family !== 'control');
p(`## refusal histogram (first-ring reason; ${refused.length} refusals)`);
p();
for (const [k, v] of hist(refused).slice(0, 25)) p(`- ${v}: ${k}`);
p();
for (const f of fams) {
	const rs = refused.filter((r) => r.family === f);
	if (!rs.length) continue;
	p(`### ${f} (${rs.length} refusals)`);
	for (const [k, v] of hist(rs).slice(0, 6)) p(`- ${v}: ${k}`);
	p();
}
p('## findings and anomalies');
p();
for (const r of all)
	if (/FALSE|DISAGREE|^raw|HANG/.test(r.kind))
		p(`- ${r.kind} ${r.id} sha ${r.sha256.slice(0, 16)} checker=${r.checker} verifier=${r.verifier ?? '-'} ground=${(r.ground ?? '').slice(0, 120)} bground=${(r.bground ?? '').slice(0, 80)} vreason=${(r.vreason ?? '').slice(0, 100)} reason=${(r.reason ?? '').slice(0, 120)}`);
p();
p('## slowest rows');
for (const r of [...all].sort((a, b) => b.ms - a.ms).slice(0, 8)) p(`- ${r.ms} ms ${r.id} ${r.kind}`);
p();
p('## accepted by ring and output');
const acc = all.filter((r) => r.checker === 'accepted' && r.family !== 'control');
for (const ring of ['gf2', 'z2w', 'zp'])
	p(`- ${ring}: ${acc.filter((r) => r.ring === ring && !r.output).length} fold, ${acc.filter((r) => r.ring === ring && r.output).length} in-place`);
p();
p('## full-option sample (verifier full options, heavy ground truth)');
const fr = [...fullRows.values()];
p(`${fr.length} modules; kinds ${JSON.stringify(Object.fromEntries([...new Set(fr.map((r) => r.kind))].map((k) => [k, fr.filter((r) => r.kind === k).length])))}`);
for (const r of fr) if (r.kind !== 'accepted-correct') p(`- ${r.kind} ${r.id} verifier=${r.verifier} vreason=${(r.vreason ?? '').slice(0, 100)} ground=${(r.ground ?? '').slice(0, 100)}`);
writeFileSync(join(here, 'summary.md'), out.join('\n') + '\n');
console.log(out.join('\n'));
