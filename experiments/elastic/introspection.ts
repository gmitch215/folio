import { writeFile } from 'node:fs/promises';
import { credentials } from '../lib/cloudflare.ts';
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
const names = [
	'AccountDurableObjectsPeriodicGroups',
	'AccountDurableObjectsPeriodicGroupsFilter_InputObject',
	'AccountDurableObjectsPeriodicGroupsDimensions',
	'AccountDurableObjectsPeriodicGroupsMax',
	'AccountDurableObjectsPeriodicGroupsQuantiles',
	'AccountDurableObjectsPeriodicGroupsSum'
];
const query = `{ ${names.map((name, i) => `t${i}: __type(name: "${name}") { name fields { name } inputFields { name } }`).join('\n')} }`;
const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
	method: 'POST',
	headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
	body: JSON.stringify({ query })
});
const result: any = await response.json();
await writeFile(
	new URL(
		'./introspection.json',
		new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', import.meta.url)
	),
	JSON.stringify(result, null, 2) + '\n',
	{ flag: 'wx' }
);
console.log(JSON.stringify(result));
