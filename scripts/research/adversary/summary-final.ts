import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workDir } from './lib.ts';

// usage: node summary-final.ts [DIR]; merges DIR/judge-list rows with DIR/final-select.json and
// writes DIR/final-summary.json
const root = workDir(process.argv[2]);
const select = JSON.parse(readFileSync(join(root, 'final-select.json'), 'utf8')) as {
	modules: number;
	accepted: number;
	newlyAccepted: string[];
	newlyRefused: string[];
	harnessNow: string[];
	judgeList: number;
};
const judged = new Map<string, Record<string, any>>();
const judgedDir = join(root, 'judge-list');
for (const name of readdirSync(judgedDir).filter((n) => n.startsWith('shard-')))
	for (const row of JSON.parse(readFileSync(join(judgedDir, name), 'utf8')) as Record<
		string,
		any
	>[])
		judged.set(row.id, row);

const judgedAccepted = [...judged.values()].filter((r) => r.status === 'accepted');
const wrong = judgedAccepted.filter((r) => r.wrong).map((r) => ({ id: r.id, failure: r.failure }));
const judgeHarness = [...judged.values()]
	.filter((r) => r.status === 'harness')
	.map((r) => ({ id: r.id, reason: r.reason }));

const summary = {
	modules: select.modules,
	acceptedNow: select.accepted,
	judgedThisPass: select.judgeList,
	judgedAccepted: judgedAccepted.length,
	judgedCorrect: judgedAccepted.filter((r) => !r.wrong).length,
	judgedWrong: wrong.length,
	carriedForwardNotRejudged: select.accepted - select.judgeList,
	newlyAccepted: select.newlyAccepted.length,
	newlyRefused: select.newlyRefused.length,
	certifyHarnessRows: select.harnessNow.length,
	wrong,
	judgeHarness,
	newlyAcceptedWrong: select.newlyAccepted.filter((id) => judged.get(id)?.wrong).sort(),
	newlyAcceptedHarness: select.newlyAccepted
		.filter((id) => judged.get(id)?.status === 'harness')
		.sort(),
	newlyAcceptedIds: select.newlyAccepted,
	newlyRefusedIds: select.newlyRefused,
	certifyHarnessIds: select.harnessNow
};
writeFileSync(join(root, 'final-summary.json'), JSON.stringify(summary, null, 1));
console.log(
	JSON.stringify(
		{
			...summary,
			newlyAcceptedIds: undefined,
			newlyRefusedIds: undefined,
			certifyHarnessIds: undefined
		},
		null,
		1
	)
);
