import { analyzeAdmission } from './admission.ts';
import { analyzeAffinity } from './affinity.ts';
import { analyzeBakeSecrets } from './bakesecrets.ts';
import { analyzeBlocks } from './blocks.ts';
import { analyzeBakedBuild, analyzeBootImage } from './bootimage.ts';
import { analyzeBreakdown, analyzeMemory } from './breakdown.ts';
import { analyzeConcurrent } from './concurrent.ts';
import { analyzeControl } from './control.ts';
import { analyzeIntra } from './intra.ts';
import { analyzePageDrop } from './pagedrop.ts';
import { analyzePaired } from './paired.ts';
import { analyzeRegen } from './regen.ts';
import { analyzeScaling } from './scaling.ts';
import { analyzeSharing } from './sharing.ts';
import { analyzeSiteConc } from './siteconc.ts';
import { analyzeCensus } from './sqlcensus.ts';
import { analyzeValidation, analyzeWorksp } from './worksp.ts';

for (const set of ['memory/sharing', 'memory/large-arena', 'memory/large-repeat'])
	analyzeSharing(set);
analyzeScaling();
for (const set of ['execution/control-pilot', 'execution/control']) analyzeControl(set);
for (const set of ['execution/placement-pilot', 'execution/placement']) analyzeAffinity(set);
for (const file of ['workloads.jsonl', 'render.jsonl']) analyzePaired('php/serial', file);
for (const name of ['kernel-control', 'negative', 'machine-core', 'process-abi', 'tinyimg'])
	analyzePaired('compatibility/consumers', `${name}.jsonl`);
analyzeAdmission('execution/admission');
for (const file of ['php-workloads.jsonl', 'php-render.jsonl'])
	analyzePaired('execution/admission', file);
for (const name of [
	'kernel-control',
	'kernel-control-repeat',
	'negative',
	'small-trips',
	'small-trips-repeat',
	'machine-core',
	'process-abi',
	'process-abi-repeat',
	'tinyimg'
])
	analyzePaired('execution/admission', `${name}.jsonl`);
for (const file of ['cpu-rig.jsonl', 'drupal-rig.jsonl']) analyzeConcurrent('php/requests', file);
for (const file of ['drupal-breakdown-rig.jsonl', 'mac-drupal-breakdown.jsonl'])
	analyzeBreakdown('php/requests', file);
analyzeMemory('php/requests', ['memory-rig.jsonl']);
analyzeIntra('intra', 'php/intra-request', ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra(
	'intra',
	'php/intra-request',
	['intra-drupal-rig.jsonl'],
	'intra-drupal-rig.summary.json'
);
analyzeIntra('indirect', 'php/intra-request', ['indirect-mac.jsonl'], 'indirect-mac.summary.json');
analyzeIntra('snapshot', 'php/intra-request', ['snapshot-rig.jsonl'], 'snapshot-rig.summary.json');
for (const set of ['tasks/physical-cores', 'tasks/smt'])
	analyzeIntra('intra', set, ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra('intra', 'tasks/library', ['intra-rig.jsonl'], 'intra-rig.summary.json');
analyzeIntra('intra', 'tasks/library', ['intra-drupal-rig.jsonl'], 'intra-drupal-rig.summary.json');
for (const file of ['count.jsonl', 'trace-small.jsonl', 'trace-drupal.jsonl'])
	analyzeWorksp('analysis/span-pilot', file);
for (const file of ['controls.jsonl', 'drupal-coarse.jsonl', 'drupal-fine.jsonl'])
	analyzeWorksp('analysis/span-validation', file);
analyzeValidation('analysis/span-validation', 'validation.jsonl');
analyzeRegen('php/regeneration', 'nosmt-regen.jsonl', 'nosmt-regen.summary.json');
analyzeRegen('php/regeneration', 'smt-regen.jsonl', 'smt-regen.summary.json');
analyzeCensus('php/sql-effects', 'census.jsonl', 'summary.json');
analyzeSiteConc('portability/site-concurrency');
analyzeBlocks('php/render-blocks', 'mac-blocks.jsonl');
analyzeBootImage('boot/php-852');
analyzeBakedBuild('boot/php-8512');
analyzeBakeSecrets('boot/replay-852');
analyzeBakeSecrets('boot/replay-8512');
analyzePageDrop('boot/residency');
console.log('regenerated every summary.json under results/');
