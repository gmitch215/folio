import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApi, credentials } from '../../lib/cloudflare.ts';

const [directoryArg, modesArg = 'original,baked,assets'] = process.argv.slice(2);
assert.ok(directoryArg, 'usage: stored.ts RUN_DIRECTORY [MODES]');
const directory = resolve(directoryArg);
const api = createApi(
	credentials({
		FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
		FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
	})
);
const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
for (const mode of modesArg.split(',')) {
	const name = JSON.parse(readFileSync(join(directory, mode, 'wrangler.jsonc'), 'utf8')).name;
	const result = await api('/workers/observability/telemetry/query', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			queryId: `folio-image-final-${crypto.randomUUID()}`,
			view: 'events',
			limit: 2000,
			timeframe: { from: Math.min(...requests.map((row) => row.at)) - 60000, to: Date.now() },
			parameters: {
				filterCombination: 'and',
				filters: [
					{ key: '$metadata.service', operation: 'eq', type: 'string', value: name }
				]
			}
		})
	});
	writeFileSync(
		join(directory, `${mode}-stored-final.json`),
		JSON.stringify(result, null, 2) + '\n',
		{ flag: 'wx' }
	);
	console.log(JSON.stringify({ mode, events: result.events?.count ?? null }));
}
