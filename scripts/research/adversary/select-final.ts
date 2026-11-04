import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry, workDir } from './lib.ts';

// usage: node select-final.ts DIR PREVIOUS; merges DIR/certify rows, classifies each module against
// the verdicts in the JSON file PREVIOUS (for the study, adversary-modules.json) and writes the judge
// list: every newly accepted module plus a seeded 10% sample of the previously accepted set
const root = workDir(process.argv[2]);
const previous = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as {
	id: string;
	verdict: string;
}[];
const prevAccepted = previous
	.filter((m) => m.verdict === 'accepted-and-correct' || m.verdict === 'ACCEPTED-AND-WRONG')
	.map((m) => m.id);
const prevSet = new Set(prevAccepted);

type Row = { id: string; kind: string; reason?: string; ring?: string; bits?: number };
const now = new Map<string, Row>();
const certifyDir = join(root, 'certify');
for (const name of readdirSync(certifyDir).filter((n) => n.startsWith('shard-')))
	for (const row of JSON.parse(readFileSync(join(certifyDir, name), 'utf8')) as Row[])
		now.set(row.id, row);

const nowAccepted = new Set([...now].filter(([, r]) => r.kind === 'certificate').map(([id]) => id));
const newlyAccepted = [...nowAccepted].filter((id) => !prevSet.has(id)).sort();
const newlyRefused = prevAccepted.filter((id) => !nowAccepted.has(id)).sort();
const harnessNow = [...now]
	.filter(([, r]) => r.kind === 'harness')
	.map(([id]) => id)
	.sort();

const rnd = mulberry(20261103);
const pool = [...prevAccepted].sort();
const sampleSize = Math.round(pool.length * 0.1);
const sample = new Set<string>();
while (sample.size < sampleSize) sample.add(pool[Math.floor(rnd() * pool.length)]!);
const sampled = [...sample].filter((id) => nowAccepted.has(id)).sort();

const judgeList = [...new Set([...newlyAccepted, ...sampled])].sort();
writeFileSync(join(root, 'final-judge-list.json'), JSON.stringify(judgeList, null, 1));
writeFileSync(
	join(root, 'final-select.json'),
	JSON.stringify(
		{
			modules: now.size,
			accepted: nowAccepted.size,
			previouslyAccepted: prevAccepted.length,
			newlyAccepted,
			newlyRefused,
			harnessNow,
			sampleSize,
			sampled,
			judgeList: judgeList.length
		},
		null,
		1
	)
);
console.log(
	JSON.stringify({
		modules: now.size,
		accepted: nowAccepted.size,
		previouslyAccepted: prevAccepted.length,
		newlyAccepted: newlyAccepted.length,
		newlyRefused: newlyRefused.length,
		harnessNow: harnessNow.length,
		sampleSize,
		sampledStillAccepted: sampled.length,
		judgeList: judgeList.length
	})
);
