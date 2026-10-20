import { analyzeAffinity } from './affinity.ts';
import { analyzeControl } from './control.ts';
import { analyzeScaling } from './scaling.ts';
import { analyzeSharing } from './sharing.ts';

for (const set of ['20261019', '20261019-b', '20261019-c']) analyzeSharing(set);
analyzeScaling();
for (const set of ['20261020-control', '20261020-control-b']) analyzeControl(set);
for (const set of ['20261020-affinity', '20261020-affinity-final']) analyzeAffinity(set);
console.log('regenerated every summary.json under results/');
