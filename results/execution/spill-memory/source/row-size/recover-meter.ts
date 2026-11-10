import { readFile, writeFile } from 'node:fs/promises';
import { credentials } from '../../../../experiments/lib/cloudflare.ts';
import { makeGql } from './meter.ts';

// namespaces the run never listed (the listing is paged at 20): read every namespace's rows in the
// run window and keep the ones that are not in namespaces.json, labelled by order of first minute
const [dir, since, until] = process.argv.slice(2);
const env = process.env;
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: env.FREE_CLOUDFLARE_API_TOKEN
});
const gql = makeGql(creds);
const known = new Set(
	(JSON.parse(await readFile(`${dir}/namespaces.json`, 'utf8')) as { id: string }[]).map((n) => n.id)
);
const data = await gql(
	`query ($account: String!, $since: Time!, $until: Time!) {
		viewer { accounts(filter: { accountTag: $account }) {
			g: durableObjectsPeriodicGroups(
				limit: 1000
				filter: { datetime_geq: $since, datetime_leq: $until }
				orderBy: [datetimeMinute_ASC]
			) {
				dimensions { namespaceId datetimeMinute }
				max { memoryUsageBytes }
				sum { rowsWritten rowsRead }
			}
		} }
	}`,
	{ since, until }
);
const rows = (data.viewer.accounts[0]?.g ?? []) as any[];
const label = new Map<string, string>();
const out: object[] = [];
for (const row of rows) {
	const id = String(row.dimensions.namespaceId);
	if (known.has(id)) continue;
	if (!label.has(id)) label.set(id, `unknown-${label.size}`);
	out.push({
		cls: label.get(id),
		minute: row.dimensions.datetimeMinute,
		maxMemoryBytes: row.max.memoryUsageBytes,
		rowsWritten: row.sum.rowsWritten,
		rowsRead: row.sum.rowsRead
	});
}
await writeFile(`${dir}/meter-unlisted.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ rows: rows.length, unlistedRows: out.length, unlistedClasses: label.size }));
for (const row of out as any[])
	console.log(row.cls, row.minute, (row.maxMemoryBytes / 1048576).toFixed(1), row.rowsWritten);
