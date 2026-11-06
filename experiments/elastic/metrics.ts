import { readFile, writeFile } from 'node:fs/promises';
import { credentials } from '../lib/cloudflare.ts';

const directory = new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', import.meta.url);
const { name } = JSON.parse(await readFile(new URL('./source.json', directory), 'utf8'));
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
const start = new Date(Date.now() - 30 * 60000).toISOString(),
	end = new Date().toISOString();
const query = `query($account: string!, $script: string!, $start: Time!, $end: Time!) {
	viewer { accounts(filter: { accountTag: $account }) {
		workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
			sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP99 }
		}
	} }
}`;
const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
	method: 'POST',
	headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
	body: JSON.stringify({
		query,
		variables: { account: creds.account, script: name, start, end }
	}),
	signal: AbortSignal.timeout(30000)
});
const body: any = await response.json();
const result = {
	requestedAt: end,
	start,
	status: response.status,
	body,
	scope: 'script-filtered analytics; not per-executor/owner isolation without role dimensions'
};
await writeFile(
	new URL(`metrics-${process.env.FOLIO_METRICS_RECORD ?? 'first'}.json`, directory),
	JSON.stringify(result, null, 2) + '\n',
	{ flag: 'wx' }
);
console.log(
	JSON.stringify({
		status: response.status,
		errors: body.errors?.map((e: any) => e.message),
		groups: body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.length
	})
);
