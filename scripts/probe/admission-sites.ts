import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MINIMUM_REGION_WORK, extract, netWork } from '../../src/extract.ts';
import type { Consumer } from './consumer.ts';

// usage: node scripts/probe/admission-sites.ts OUTPUT.jsonl CONSUMER.ts...
// lists every region candidate of each consumer with its estimate at the default threshold
const [output, ...files] = process.argv.slice(2);
if (!output || !files.length)
	throw new Error('usage: admission-sites.ts OUTPUT.jsonl CONSUMER.ts...');
writeFileSync(output, '');
for (const file of files) {
	const consumer: Consumer = (await import(pathToFileURL(resolve(file)).href)).default;
	const sites: Record<string, unknown>[] = [];
	const refusals: string[] = [];
	const plan = extract(consumer.bytes, (bytes) => ({ transactional: bytes }), {
		observed: (site) => sites.push({ ...site, net: netWork(site) }),
		refused: (reason) => refusals.push(reason)
	});
	appendFileSync(
		output,
		JSON.stringify({
			consumer: consumer.name,
			minimumRegionWork: DEFAULT_MINIMUM_REGION_WORK,
			planned: Boolean(plan),
			regions: plan?.regions.length ?? 0,
			refusals,
			sites
		}) + '\n'
	);
}
