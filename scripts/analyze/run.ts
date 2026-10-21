import { analyzeAdmission } from './admission.ts';
import { analyzeAffinity } from './affinity.ts';
import { analyzeBreakdown, analyzeMemory } from './breakdown.ts';
import { analyzeConcurrent } from './concurrent.ts';
import { analyzeControl } from './control.ts';
import { analyzeIntra } from './intra.ts';
import { analyzePaired } from './paired.ts';
import { analyzeScaling } from './scaling.ts';
import { analyzeSharing } from './sharing.ts';
import { analyzeValidation, analyzeWorksp } from './worksp.ts';

for (const set of ['20261019', '20261019-b', '20261019-c']) analyzeSharing(set);
analyzeScaling();
for (const set of ['20261020-control', '20261020-control-b']) analyzeControl(set);
for (const set of ['20261020-affinity', '20261020-affinity-final']) analyzeAffinity(set);
for (const file of ['workloads.jsonl', 'render.jsonl']) analyzePaired('20261020-php', file);
for (const name of ['kernel-control', 'negative', 'gmux-core', 'gmux-abi', 'tinyimg'])
	analyzePaired('20261020-consumers', `${name}.jsonl`);
analyzeAdmission('20261020-regress');
for (const file of ['php-workloads.jsonl', 'php-render.jsonl'])
	analyzePaired('20261020-regress', file);
for (const name of [
	'kernel-control',
	'kernel-control-b',
	'negative',
	'small-trips',
	'small-trips-b',
	'gmux-core',
	'gmux-abi',
	'gmux-abi-b',
	'tinyimg'
])
	analyzePaired('20261020-regress', `${name}.jsonl`);
for (const file of ['cpu-rig.jsonl', 'drupal-rig.jsonl'])
	analyzeConcurrent('20261020-phpparallel', file);
for (const file of ['drupal-breakdown-rig.jsonl', 'mac-drupal-breakdown.jsonl'])
	analyzeBreakdown('20261020-phpparallel', file);
analyzeMemory('20261020-phpparallel', ['memory-rig.jsonl']);
analyzeIntra('intra', '20261020-phpintra', ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra(
	'intra',
	'20261020-phpintra',
	['intra-drupal-rig.jsonl'],
	'intra-drupal-rig.summary.json'
);
analyzeIntra('compile', '20261020-phpintra', ['compile-rig.jsonl'], 'compile-rig.summary.json');
analyzeIntra('indirect', '20261020-phpintra', ['indirect-mac.jsonl'], 'indirect-mac.summary.json');
analyzeIntra('snapshot', '20261020-phpintra', ['snapshot-rig.jsonl'], 'snapshot-rig.summary.json');
for (const set of ['20261020-phpwidth-nosmt', '20261020-phpwidth-smt'])
	analyzeIntra('intra', set, ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra('intra', '20261020-phptasks-lib', ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra(
	'intra',
	'20261020-phptasks-lib',
	['intra-drupal-rig.jsonl'],
	'intra-drupal-rig.summary.json'
);
for (const file of ['count.jsonl', 'trace-small.jsonl', 'trace-drupal.jsonl'])
	analyzeWorksp('20261020-worksp', file);
for (const file of ['controls.jsonl', 'drupal-coarse.jsonl', 'drupal-fine.jsonl'])
	analyzeWorksp('20261020-worksp2', file);
analyzeValidation('20261020-worksp2', 'validation.jsonl');
console.log('regenerated every summary.json under results/');
