import { readFileSync, writeFileSync } from 'node:fs';
import { consumerRoot } from './consumer-root.ts';
import { defaultSizes, openTaskContexts, requestCode, workloads } from './php-tasks.ts';

// differential validation of a private-state site: the request runs serially in the owner (plain) and
// through the explicit task API on private contexts, and the output digests must be equal
// usage: node scripts/probe/worksp-validate.ts OUTPUT.jsonl [SAMPLES]
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE as in php-concurrent.ts
const [output, samplesArg] = process.argv.slice(2);
if (!output) throw new Error('usage: worksp-validate.ts OUTPUT.jsonl [SAMPLES]');
const samples = Number(samplesArg ?? 3);
const consumer = consumerRoot();
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const rows: object[] = [];
const emit = (row: object) => {
	rows.push(row);
	writeFileSync(output, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const defs = {
	chain: `<?php function f($x){return hash('sha256',str_repeat($x,64));}`,
	shared: `<?php function g($i){global $cnt;$cnt=($cnt??0)+$i+1;$h=(string)$cnt;for($j=0;$j<30;$j++){$h=hash('sha256',str_repeat($h,64));}return $h;}`
};
const api = (calls: string) => `<?php $GLOBALS['__t_inline_mode']=false;${calls}`;
const sites = [
	{
		site: 'w_hash',
		kind: 'plain' as const,
		plain: requestCode(
			workloads.find((w) => w.name === 'hash-batch')!,
			{ n: 60 },
			'plain'
		),
		task: requestCode(
			workloads.find((w) => w.name === 'hash-batch')!,
			{ n: 60 },
			'api'
		)
	},
	{
		site: 'f (dependent chain)',
		kind: 'plain' as const,
		define: defs.chain,
		plain: `<?php $x='seed';for($i=0;$i<40;$i++){$x=f($x);}echo md5($x);`,
		task: api(
			`$x='seed';for($i=0;$i<40;$i++){$x=task_join(task_submit('f',[$x]));}echo md5($x);`
		)
	},
	{
		site: 'g (shared variable)',
		kind: 'plain' as const,
		define: defs.shared,
		plain: `<?php $out=[];for($i=0;$i<8;$i++){$out[]=g($i);}echo md5(serialize($out));`,
		task: api(
			`$ids=[];for($i=0;$i<8;$i++){$ids[]=task_submit('g',[$i]);}$out=[];foreach($ids as $id){$out[]=task_join($id);}echo md5(serialize($out));`
		)
	},
	{
		site: 'w_render',
		kind: 'drupal' as const,
		plain: requestCode(
			workloads.find((w) => w.name === 'drupal-render-arrays')!,
			{ n: 40 },
			'plain'
		),
		task: requestCode(
			workloads.find((w) => w.name === 'drupal-render-arrays')!,
			{ n: 40 },
			'api'
		)
	}
];
void defaultSizes;
void readFileSync;

for (const kind of ['plain', 'drupal'] as const) {
	const chosen = sites.filter((s) => s.kind === kind);
	const contexts = await openTaskContexts({ servers: 8, kind, mode: 'native', bundle, consumer });
	try {
		for (const s of chosen) {
			if ((s as any).define) await contexts.runAll((s as any).define);
			for (let k = 0; k < samples; k++) {
				const task = await contexts.run(0, s.task);
				const plain = await contexts.run(0, s.plain);
				emit({
					kind: 'sample',
					site: s.site,
					sample: k,
					plainSha256: plain.sha256,
					taskSha256: task.sha256,
					plainError: plain.error,
					taskError: task.error,
					equal: !plain.error && !task.error && plain.sha256 === task.sha256,
					machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
					node: process.version
				});
			}
		}
	} finally {
		await contexts.close();
	}
}
