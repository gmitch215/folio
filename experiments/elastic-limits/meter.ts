import type { Api, Credentials } from '../lib/cloudflare.ts';
import { redact } from './redact.ts';

export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export interface Namespace {
	id: string;
	cls: string;
}

export interface MeterRow {
	cls: string;
	minute: string;
	maxMemoryBytes: number;
	cpuTimeUs: number;
	exceededCpu: number;
	exceededMemory: number;
	rowsWritten: number;
	rowsRead: number;
	subrequests: number;
}

const endpoint = 'https://api.cloudflare.com/client/v4/graphql';

export function makeGql({ account, token }: Credentials, fetchImpl: typeof fetch = fetch): Gql {
	return async (query, variables = {}) => {
		const response = await fetchImpl(endpoint, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ query, variables: { account, ...variables } }),
			signal: AbortSignal.timeout(30000)
		});
		const body: any = await response.json();
		if (!response.ok || body.errors)
			throw new Error(
				`graphql: ${redact(JSON.stringify(body.errors ?? response.status)).slice(0, 400)}`
			);
		return body.data;
	};
}

// rows written and requests today (UTC) across every Worker and object on the account
export async function spentToday(gql: Gql, now = new Date()) {
	const day = now.toISOString().slice(0, 10);
	const data = await gql(
		`query ($account: String!, $day: Date!, $since: Time!) {
			viewer { accounts(filter: { accountTag: $account }) {
				w: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since }) { sum { requests } }
				d: durableObjectsPeriodicGroups(limit: 1, filter: { date_geq: $day }) { sum { rowsWritten } }
			} }
		}`,
		{ day, since: `${day}T00:00:00Z` }
	);
	const account = data.viewer.accounts[0];
	return {
		requests: account?.w?.[0]?.sum?.requests ?? 0,
		rowsWritten: account?.d?.[0]?.sum?.rowsWritten ?? 0
	};
}

export async function namespacesOf(api: Api, script: string): Promise<Namespace[]> {
	const rows = await api('/workers/durable_objects/namespaces?per_page=100');
	return rows
		.filter((row: any) => row.script === script)
		.map((row: any) => ({ id: String(row.id), cls: String(row.class) }));
}

// per-minute rows of each class's namespace; the memory figure is the platform meter
export async function readMeter(
	gql: Gql,
	namespaces: Namespace[],
	since: string,
	until: string
): Promise<MeterRow[]> {
	for (const ns of namespaces)
		if (!/^[0-9a-f]{32}$/.test(ns.id)) throw new Error('bad namespace id');
	const aliases = namespaces
		.map(
			(ns, i) => `n${i}: durableObjectsPeriodicGroups(
				limit: 200
				filter: { namespaceId: "${ns.id}", datetime_geq: $since, datetime_leq: $until }
				orderBy: [datetimeMinute_ASC]
			) {
				dimensions { datetimeMinute }
				max { memoryUsageBytes }
				sum { cpuTime exceededCpuErrors exceededMemoryErrors rowsWritten rowsRead subrequests }
			}`
		)
		.join('\n');
	const data = await gql(
		`query ($account: String!, $since: Time!, $until: Time!) {
			viewer { accounts(filter: { accountTag: $account }) { ${aliases} } }
		}`,
		{ since, until }
	);
	const account = data.viewer.accounts[0] ?? {};
	return namespaces.flatMap((ns, i) =>
		(account[`n${i}`] ?? []).map((row: any) => ({
			cls: ns.cls,
			minute: row.dimensions.datetimeMinute,
			maxMemoryBytes: row.max.memoryUsageBytes,
			cpuTimeUs: row.sum.cpuTime,
			exceededCpu: row.sum.exceededCpuErrors,
			exceededMemory: row.sum.exceededMemoryErrors,
			rowsWritten: row.sum.rowsWritten,
			rowsRead: row.sum.rowsRead,
			subrequests: row.sum.subrequests
		}))
	);
}

// the form the first probe used: one aggregate per class, no minute dimension; a cross-check on readMeter
export async function readAggregate(
	gql: Gql,
	namespaces: Namespace[],
	since: string,
	until: string
) {
	for (const ns of namespaces)
		if (!/^[0-9a-f]{32}$/.test(ns.id)) throw new Error('bad namespace id');
	const aliases = namespaces
		.map(
			(ns, i) => `n${i}: durableObjectsPeriodicGroups(
				limit: 1
				filter: { namespaceId: "${ns.id}", datetime_geq: $since, datetime_leq: $until }
			) {
				max { memoryUsageBytes }
				sum { rowsWritten cpuTime }
			}`
		)
		.join('\n');
	const data = await gql(
		`query ($account: String!, $since: Time!, $until: Time!) {
			viewer { accounts(filter: { accountTag: $account }) { ${aliases} } }
		}`,
		{ since, until }
	);
	const account = data.viewer.accounts[0] ?? {};
	return namespaces.flatMap((ns, i) =>
		(account[`n${i}`] ?? []).map((row: any) => ({
			cls: ns.cls,
			maxMemoryBytes: row.max.memoryUsageBytes,
			rowsWritten: row.sum.rowsWritten,
			cpuTimeUs: row.sum.cpuTime
		}))
	);
}

export const signature = (rows: MeterRow[]) =>
	JSON.stringify(
		rows.map((r) => [
			r.cls,
			r.minute,
			r.maxMemoryBytes,
			r.rowsWritten,
			r.rowsRead,
			r.subrequests
		])
	);

// the meter lags the run by minutes, so read until two reads in a row agree
// rows not yet published are absent; settled says whether the last two reads matched
export async function readSettled(
	gql: Gql,
	namespaces: Namespace[],
	since: string,
	options: {
		sleep: (ms: number) => Promise<void>;
		firstWaitMs?: number;
		pollMs?: number;
		maxPolls?: number;
		onPoll?: (line: object) => void;
	}
) {
	const { sleep, firstWaitMs = 180000, pollMs = 60000, maxPolls = 12, onPoll } = options;
	await sleep(firstWaitMs);
	let previous = '',
		rows: MeterRow[] = [],
		aggregate: Awaited<ReturnType<typeof readAggregate>> = [];
	for (let poll = 1; poll <= maxPolls; poll++) {
		const until = new Date(Date.now() + 60000).toISOString();
		rows = await readMeter(gql, namespaces, since, until);
		aggregate = rows.length ? [] : await readAggregate(gql, namespaces, since, until);
		const now = signature(rows);
		onPoll?.({
			meterPoll: poll,
			rows: rows.length,
			aggregateClasses: aggregate.length,
			settled: rows.length > 0 && now === previous
		});
		if (rows.length > 0 && now === previous) return { rows, settled: true, polls: poll };
		previous = now;
		await sleep(pollMs);
	}
	return { rows, aggregate, settled: false, polls: maxPolls };
}
