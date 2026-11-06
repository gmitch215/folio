import { readFile, writeFile } from 'node:fs/promises';
import { createApi, credentials, inventory, inventoryDiff } from '../lib/cloudflare.ts';
const directory = new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', import.meta.url);
const baseline = JSON.parse(await readFile(new URL('./baseline.json', directory), 'utf8'));
const { name } = JSON.parse(await readFile(new URL('./source.json', directory), 'utf8'));
const api = createApi(
	credentials({
		FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
		FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
	})
);
const after = await inventory(api);
const differences = inventoryDiff(
	baseline,
	after,
	(entry) => entry.name === name || entry.script === name
);
await writeFile(
	new URL('./cleanup-later.json', directory),
	JSON.stringify(
		{ differences, ownResourcesRestored: differences.every((row) => !row.mine) },
		null,
		2
	) + '\n',
	{ flag: 'wx' }
);
console.log(
	JSON.stringify({
		ownResourcesRestored: differences.every((row) => !row.mine),
		changes: differences.length
	})
);
