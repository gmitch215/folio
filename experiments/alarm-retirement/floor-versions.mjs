// usage: node floor-versions.mjs <epoch ms>; run in the rig dir after a smoke attempt that started at that time
// lists the scriptVersion id of each smoke request in tail.jsonl and the id in deploy.log
// exit 0 when all smoke requests since the time share one version id; 4 when they differ; 6 when fewer than 3 requests
import { readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

const since = Number(process.argv[2]);
if (!Number.isFinite(since)) throw new Error('usage: floor-versions.mjs <epoch ms>');
const deployId =
	readFileSync('deploy.log', 'utf8').match(/Current Version ID:\s*(\S+)/)?.[1] ?? null;
const smoke = readTail('tail.jsonl').filter(
	(e) => String(e.event?.request?.url ?? '').includes('do=smoke-') && e.eventTimestamp >= since
);
for (const e of smoke) {
	const obj = new URL(e.event.request.url).searchParams.get('do');
	const exception = (e.exceptions ?? []).map((x) => x.message).join(' | ');
	console.log(
		`request ${obj} version=${e.scriptVersion?.id ?? null} outcome=${e.outcome} exception="${exception}" logs=${JSON.stringify((e.logs ?? []).map((l) => l.message))}`
	);
}
const ids = [...new Set(smoke.map((e) => e.scriptVersion?.id ?? null))];
console.log(
	`deploy version=${deployId} smoke events=${smoke.length} distinct smoke version ids=${ids.length}`
);
console.log(`smoke version ids: ${ids.join(', ')}`);
console.log(`all smoke ids equal the deploy id: ${ids.length === 1 && ids[0] === deployId}`);
const requests = new Set(smoke.map((e) => new URL(e.event.request.url).searchParams.get('do')));
if (requests.size < 3) process.exit(6);
if (ids.length !== 1) process.exit(4);
