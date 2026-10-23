import { sessionBudget } from './plan.ts';

export interface Meter {
	workerRequests: number;
	durableObjectRequests: number;
	durableObjectDurationGbS: number;
	rowsRead: number;
	rowsWritten: number;
	error?: string;
}

type Save = (file: string, value: unknown) => Promise<void>;
type Log = (stage: string, extra?: object) => void;

/** Reads today's account usage from the GraphQL analytics API; an unreadable meter is reported, not guessed. */
export async function readMeter(account: string, token: string, since?: string): Promise<Meter> {
	const empty = {
		workerRequests: 0,
		durableObjectRequests: 0,
		durableObjectDurationGbS: 0,
		rowsRead: 0,
		rowsWritten: 0
	};
	const day = since ?? new Date().toISOString().slice(0, 10);
	const query = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
		w:workersInvocationsAdaptive(limit:10000,filter:{date_geq:$d}){sum{requests}}
		d:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date_geq:$d}){sum{requests}}
		p:durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$d}){sum{duration rowsRead rowsWritten}}}}}`;
	try {
		const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ query, variables: { a: account, d: day } }),
			signal: AbortSignal.timeout(20000)
		});
		const body: any = await response.json();
		if (body.errors?.length) return { ...empty, error: String(body.errors[0].message) };
		const data = body.data.viewer.accounts[0];
		const total = (rows: any[], key: string) =>
			rows.reduce((sum, row) => sum + (row.sum?.[key] ?? 0), 0);
		return {
			workerRequests: total(data.w, 'requests'),
			durableObjectRequests: total(data.d, 'requests'),
			durableObjectDurationGbS: total(data.p, 'duration'),
			rowsRead: total(data.p, 'rowsRead'),
			rowsWritten: total(data.p, 'rowsWritten')
		};
	} catch (error) {
		return { ...empty, error: String(error) };
	}
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function call(url: string, secret: string, method: string, timeout: number) {
	const began = performance.now();
	const response = await fetch(url, {
		method,
		headers: { authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(timeout)
	});
	const body = await response.text();
	return { status: response.status, wallMs: performance.now() - began, body };
}

const parse = (body: string) => {
	try {
		return JSON.parse(body);
	} catch {
		return { error: body.slice(0, 2048) };
	}
};

/** One browser session per request, 20 s apart; the page reports its own rows and the Worker its meter. */
export async function runSessions(
	url: string,
	secret: string,
	requests: string[],
	save: Save,
	log: Log,
	meter: () => Promise<Meter>
) {
	const used = parse((await call(`${url}/meter`, secret, 'GET', 30000)).body);
	await save('meter-before.json', used);
	log('meter', { browserMinutesToday: used.usedMinutes, ...(await meter()) });
	if (typeof used.usedMinutes !== 'number') throw new Error('browser minutes unreadable');
	const planned = (requests.length * sessionBudget.sessionSeconds) / 60;
	if (used.usedMinutes + planned > sessionBudget.dailyMinutes)
		throw new Error(`plan needs ${planned} browser minutes, ${used.usedMinutes} already used`);
	const results: Record<string, unknown>[] = [];
	for (const [index, query] of requests.entries()) {
		if (index > 0) await pause((sessionBudget.secondsBetweenLaunches + 2) * 1000);
		const { status, wallMs, body } = await call(
			`${url}/run?${query}`,
			secret,
			'POST',
			(sessionBudget.sessionSeconds + 20) * 1000
		);
		const result = parse(body);
		await save(`result-${index}-${new URLSearchParams(query).get('consumer')}.json`, {
			status,
			externalWallMs: wallMs,
			query,
			result
		});
		results.push(result);
		log('session', {
			query,
			status,
			passed: result.passed,
			error: result.error?.slice(0, 300),
			sessionWallMs: result.sessionWallMs,
			...(await meter())
		});
		if (!result.passed) break;
	}
	return results;
}

/** The PHP probe's fixed sequence: Worker CPU refusal, cold boot, warm work, then the memory plateau. */
export async function runPhp(
	url: string,
	secret: string,
	variant: 'php' | 'prepared',
	save: Save,
	log: Log,
	meter: () => Promise<Meter>
) {
	const steps: Record<string, unknown>[] = [];
	const record = async (label: string, path: string, timeout = 120000) => {
		let entry: Record<string, unknown>;
		try {
			const { status, wallMs, body } = await call(`${url}${path}`, secret, 'GET', timeout);
			entry = {
				label,
				path,
				status,
				wallMs,
				body: body.length > 8000 ? body.slice(-4000) : body
			};
		} catch (error) {
			entry = { label, path, error: String(error) };
		}
		steps.push(entry);
		log('php', { label, status: entry.status, wallMs: entry.wallMs, ...(await meter()) });
		return entry;
	};
	await record('worker-ping', '/worker-ping');
	if (variant === 'prepared')
		for (const part of ['lane', 'tracked', 'coordinator'])
			await record(`prepared-${part}`, `/prepared?part=${part}`);
	await record('worker-boot', '/worker-boot');
	await record('worker-work', '/worker-work?n=20000');
	await record('boot-cold', '/boot');
	for (let index = 0; index < 3; index++) await record(`work-${index}`, '/work?n=20000');
	for (let index = 0; index < 2; index++) await record(`work-big-${index}`, '/work?n=200000');
	await record('plateau-js', '/plateau?kind=js&step=8&max=200');
	await record('boot-after-plateau', '/boot');
	await record('plateau-php', '/plateau?kind=php&step=8&max=200');
	await save('steps.json', steps);
	return steps;
}
