import { flattenPeriodic, type PeriodicRow } from './analyze.ts';

const query = `query($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsPeriodicGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        dimensions { objectId name }
        sum { activeTime cpuTime duration exceededMemoryErrors rowsRead rowsWritten }
      }
    }
  }
}`;

/** The raw GraphQL reply for the window; an errors array is returned as is so the caller keeps it. */
export async function periodicRows(account: string, token: string, start: number, end: number) {
	const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			query,
			variables: {
				account,
				start: new Date(start).toISOString(),
				end: new Date(end).toISOString()
			}
		}),
		signal: AbortSignal.timeout(30000)
	});
	return (await response.json()) as any;
}

const key = (rows: PeriodicRow[], names: readonly string[]) =>
	JSON.stringify(
		names.map((name) => {
			const row = rows.find((item) => item.name === name);
			return row && [row.duration, row.activeTime, row.cpuTime, row.exceededMemoryErrors];
		})
	);

export interface Settle {
	firstWaitMs: number;
	pollMs: number;
	maximumMs: number;
	sleep: (milliseconds: number) => Promise<unknown>;
}

const real: Settle = {
	firstWaitMs: 480000,
	pollMs: 60000,
	maximumMs: 900000,
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
};

/**
 * Waits for the dataset's lag once, then polls until every named object has a row and two reads in a
 * row agree; the last reply is returned either way, with `complete` saying which.
 */
export async function settlePeriodic(
	read: (start: number, end: number) => Promise<any>,
	names: readonly string[],
	start: number,
	log: (stage: string, extra?: object) => void,
	settle: Settle = real
) {
	let waited = settle.firstWaitMs;
	await settle.sleep(settle.firstWaitMs);
	let previous: string | undefined;
	for (let poll = 1; ; poll++) {
		const body = await read(start, Date.now());
		const rows = flattenPeriodic(body);
		const present = names.filter((name) => rows.some((row) => row.name === name)).length;
		const current = key(rows, names);
		const complete = present === names.length && current === previous;
		log('periodic', { poll, present, wanted: names.length, errors: body?.errors?.length ?? 0 });
		if (complete || waited >= settle.maximumMs) return { body, complete, polls: poll };
		previous = current;
		await settle.sleep(settle.pollMs);
		waited += settle.pollMs;
	}
}
