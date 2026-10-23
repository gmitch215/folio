import { createHash } from 'node:crypto';
import { invocations, parseTail } from '../consumer/php/analyze.ts';

type Row = Record<string, any>;

/** the parts of a Drupal page that differ on every render of the same site */
export function normalizeBody(html: string): string {
	return html
		.replace(/js-view-dom-id-[0-9a-f]{64}/g, 'js-view-dom-id-X')
		.replace(/form-[A-Za-z0-9_-]{43}/g, 'form-X')
		.replace(/form_build_id" value="[^"]*"/g, 'form_build_id" value="X"');
}

export const bodyHash = (html: string) =>
	createHash('sha256').update(normalizeBody(html)).digest('hex').slice(0, 16);

export const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length / 2;
	return sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const range = (values: number[]) => ({
	n: values.length,
	median: values.length ? median(values) : null,
	min: values.length ? Math.min(...values) : null,
	max: values.length ? Math.max(...values) : null
});

export interface StepRow {
	arm: string;
	object: string;
	kind: 'migrate' | 'seed' | 'measure' | 'csrf' | 'deliver' | 'phase';
	tag?: string;
	status?: number;
	wallMs?: number;
	bytes?: number;
	bodyHash?: string;
	warm?: number;
	baked?: boolean;
	token?: string;
	rowsWritten?: number;
	error?: string;
	delivery?: Record<string, any>;
	phase?: string;
}

/** the Durable Object invocation of a tagged request, from a tail file */
export function cpuByTag(tail: string, tags: string[]) {
	const calls = invocations(parseTail(tail)).filter((call) => call.entrypoint !== 'worker');
	const out: Record<string, { cpuMs: number; wallMs: number; outcome: string } | undefined> = {};
	for (const tag of tags) {
		const hits = calls.filter((call) => new RegExp(`[?&]tag=${tag}(&|$)`).test(call.path));
		out[tag] =
			hits.length === 1
				? { cpuMs: hits[0]!.cpuMs, wallMs: hits[0]!.wallMs, outcome: hits[0]!.outcome }
				: undefined;
	}
	return out;
}

/** outcome counts over every invocation in a tail file, so a reset shows up wherever it happened */
export function outcomes(tail: string) {
	const tally: Record<string, number> = {};
	for (const call of invocations(parseTail(tail))) {
		tally[call.outcome] = (tally[call.outcome] ?? 0) + 1;
	}
	return tally;
}

export interface ArmSummary {
	arm: string;
	objects: number;
	cpu: ReturnType<typeof range>;
	wall: ReturnType<typeof range>;
	missingCpu: string[];
	bodyHashes: string[];
	statuses: number[];
	bytes: number[];
	warm: number[];
	tokens: string[];
}

/** per arm statistics over the measured rows, joined to the tail by tag */
export function summarizeArm(arm: string, rows: StepRow[], tails: string): ArmSummary {
	const measured = rows.filter((row) => row.arm === arm && row.kind === 'measure');
	const joined = cpuByTag(
		tails,
		measured.map((row) => row.tag!)
	);
	const cpu = measured.flatMap((row) => (joined[row.tag!] ? [joined[row.tag!]!.cpuMs] : []));
	return {
		arm,
		objects: measured.length,
		cpu: range(cpu),
		wall: range(measured.flatMap((row) => (row.wallMs === undefined ? [] : [row.wallMs]))),
		missingCpu: measured.filter((row) => !joined[row.tag!]).map((row) => row.tag!),
		bodyHashes: [...new Set(measured.flatMap((row) => (row.bodyHash ? [row.bodyHash] : [])))],
		statuses: measured.map((row) => row.status ?? 0),
		bytes: measured.map((row) => row.bytes ?? 0),
		warm: measured.map((row) => row.warm ?? -1),
		tokens: [
			...new Set(
				rows.flatMap((row) =>
					row.arm === arm && row.kind === 'csrf' && row.token ? [row.token] : []
				)
			)
		]
	};
}

/** the saving of the second arm against the first, as a fraction of the first's median */
export function saving(control: ArmSummary, other: ArmSummary) {
	const a = control.cpu.median;
	const b = other.cpu.median;
	const wa = control.wall.median;
	const wb = other.wall.median;
	return {
		cpuRatio: a && b ? b / a : null,
		cpuSavingPercent: a && b ? (1 - b / a) * 100 : null,
		wallRatio: wa && wb ? wb / wa : null,
		wallSavingPercent: wa && wb ? (1 - wb / wa) * 100 : null
	};
}

/** a mean of the paired differences, for rounds that ran both arms back to back */
export function pairedCpu(
	rows: StepRow[],
	tails: string,
	control: string,
	other: string
): { round: number; control: number; other: number }[] {
	const measured = rows.filter((row) => row.kind === 'measure');
	const joined = cpuByTag(
		tails,
		measured.map((row) => row.tag!)
	);
	const byRound = (arm: string) =>
		measured.filter((row) => row.arm === arm).map((row) => joined[row.tag!]?.cpuMs);
	const a = byRound(control);
	const b = byRound(other);
	const pairs: { round: number; control: number; other: number }[] = [];
	for (let i = 0; i < Math.min(a.length, b.length); i++)
		if (a[i] !== undefined && b[i] !== undefined)
			pairs.push({ round: i, control: a[i]!, other: b[i]! });
	return pairs;
}

export interface Budget {
	maxRowsWritten: number;
	maxRequests: number;
	maxRequestsPerArm: number;
}

/** the stop rule; each limit may be lowered through the environment and never has a higher default */
export function budgetFromEnv(env: Record<string, string | undefined>): Budget {
	const limit = (name: string, fallback: number) => {
		const value = Number(env[name] ?? fallback);
		if (!Number.isFinite(value) || value <= 0 || value > fallback)
			throw new RangeError(`${name} must be a number from 1 to ${fallback}`);
		return value;
	};
	return {
		maxRowsWritten: limit('HOSTBOOT_MAX_ROWS', 60_000),
		maxRequests: limit('HOSTBOOT_MAX_REQUESTS', 500),
		maxRequestsPerArm: limit('HOSTBOOT_MAX_ARM_REQUESTS', 40)
	};
}

/** whether another object may start, given what has been spent */
export function withinBudget(
	budget: Budget,
	spent: { rowsWritten: number; requests: number; perArm: Record<string, number> },
	arm: string,
	need: number
) {
	if (spent.rowsWritten > budget.maxRowsWritten) return false;
	if (spent.requests + need > budget.maxRequests) return false;
	return (spent.perArm[arm] ?? 0) + need <= budget.maxRequestsPerArm;
}

/** the per-arm summary of one run, from its step rows and the tail file of each arm */
export function summarizeRun(rows: StepRow[], tails: Record<string, string>) {
	const summary: Record<string, any> = { arms: {}, outcomes: {}, saving: {}, pairs: {} };
	const everyTail = Object.values(tails).join('\n');
	for (const suffix of ['', '-reboot', '-serve']) {
		for (const arm of Object.keys(tails)) {
			if (!rows.some((row) => row.arm === `${arm}${suffix}`)) continue;
			summary.arms[`${arm}${suffix}`] = summarizeArm(`${arm}${suffix}`, rows, tails[arm]!);
		}
		const control = summary.arms[`control${suffix}`];
		if (!control) continue;
		for (const arm of Object.keys(tails)) {
			const other = summary.arms[`${arm}${suffix}`];
			if (arm === 'control' || !other) continue;
			summary.saving[`${arm}${suffix || '-first'}`] = saving(control, other);
			summary.pairs[`${arm}${suffix || '-first'}`] = pairedCpu(
				rows,
				everyTail,
				`control${suffix}`,
				`${arm}${suffix}`
			);
		}
	}
	for (const arm of Object.keys(tails)) summary.outcomes[arm] = outcomes(tails[arm]!);
	const deliveries = rows.filter((row) => row.kind === 'deliver');
	if (deliveries.length) {
		const tail = Object.values(tails).join('\n');
		const joined = cpuByTag(
			tail,
			deliveries.map((row) => row.tag!)
		);
		summary.delivery = deliveries.map((row) => ({
			tag: row.tag,
			status: row.status,
			wallMs: row.wallMs,
			cpuMs: joined[row.tag!]?.cpuMs ?? null,
			...row.delivery
		}));
	}
	const phases = rows.filter((row) => row.kind === 'phase');
	if (phases.length) {
		const joined = cpuByTag(
			Object.values(tails).join('\n'),
			phases.map((row) => row.tag!)
		);
		summary.phases = phases.map((row) => ({
			arm: row.arm,
			object: row.object,
			phase: row.phase,
			status: row.status,
			wallMs: row.wallMs,
			cpuMs: joined[row.tag!]?.cpuMs ?? null,
			...row.delivery
		}));
	}
	return summary;
}
