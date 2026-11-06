import { readFile, writeFile } from 'node:fs/promises';
import { createApi, credentials } from '../lib/cloudflare.ts';
const directory = new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', import.meta.url);
const { name } = JSON.parse(await readFile(new URL('./source.json', directory), 'utf8'));
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
const api = createApi(creds);
let namespaces;
try {
	namespaces = JSON.parse(await readFile(new URL('./namespaces.json', directory), 'utf8'));
} catch {
	namespaces = (await api('/workers/durable_objects/namespaces')).filter(
		(row: any) => row.script === name
	);
	await writeFile(
		new URL('./namespaces.json', directory),
		JSON.stringify(namespaces, null, 2) + '\n',
		{ flag: 'wx' }
	);
}
const start = new Date(Date.now() - 30 * 60000).toISOString(),
	end = new Date().toISOString();
const query = `query($account: string!, $start: Time!, $end: Time!) {
	__type(name: "AccountDurableObjectsPeriodicGroupsSum") { fields { name description } }
	viewer { accounts(filter: { accountTag: $account }) {
		${namespaces
			.map(
				(
					row: any,
					i: number
				) => `n${i}: durableObjectsPeriodicGroups(limit: 1, filter: { namespaceId: "${row.id}", datetime_geq: $start, datetime_leq: $end }) {
			max { memoryUsageBytes } quantiles { memoryUsageBytesP50 memoryUsageBytesP99 }
			sum { cpuTime duration activeTime subrequests rowsRead rowsWritten storageReadUnits storageWriteUnits exceededCpuErrors exceededMemoryErrors }
		}`
			)
			.join('\n')}
	} }
}`;
const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
	method: 'POST',
	headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
	body: JSON.stringify({ query, variables: { account: creds.account, start, end } }),
	signal: AbortSignal.timeout(30000)
});
const body: any = await response.json();
const result = {
	requestedAt: end,
	start,
	status: response.status,
	roles: namespaces.map((row: any, i: number) => ({ alias: `n${i}`, class: row.class })),
	body,
	scope: 'namespace periodic samples; max is maximum reported sample, not an unsampled absolute peak'
};
await writeFile(
	new URL(`metrics-do-${process.env.FOLIO_METRICS_RECORD ?? 'first'}.json`, directory),
	JSON.stringify(result, null, 2) + '\n',
	{ flag: 'wx' }
);
console.log(
	JSON.stringify({
		status: response.status,
		errors: body.errors?.map((e: any) => e.message),
		roles: result.roles,
		data: body.data?.viewer?.accounts?.[0]
	})
);
