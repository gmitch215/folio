import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { events } from '../../cloud/analyze-tail.ts';

const [run, output, role = 'complete'] = process.argv.slice(2);
assert.ok(
	run && output && /^[a-z-]+$/.test(role),
	'usage: analyze.ts RUN_DIRECTORY OUTPUT_DIRECTORY [ROLE]'
);
mkdirSync(output, { recursive: true });
const read = (name: string) => JSON.parse(readFileSync(join(run, name), 'utf8'));
const references = new Map<string, string>();
const ref = (value: string) => {
	if (value === 'entry') return value;
	let mapped = references.get(value);
	if (!mapped) {
		mapped = `identity-${references.size + 1}`;
		references.set(value, mapped);
	}
	return mapped;
};
const sanitize = (value: any): any => {
	if (Array.isArray(value)) return value.map(sanitize);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			['module', 'object', 'instance'].includes(key) &&
			typeof entry === 'string' &&
			/^(?:[0-9a-f]{64}|[0-9a-f-]{36})$/.test(entry)
				? ref(entry)
				: sanitize(entry)
		])
	);
};
const traces = events(readFileSync(join(run, 'tail.jsonl'), 'utf8')) as any[];
const telemetry = traces.flatMap((trace, event) =>
	trace.logs.flatMap((log: any) =>
		log.message.flatMap((message: string) => {
			try {
				const value = JSON.parse(message);
				return value.probe === 'folio-phases'
					? [
							{
								...sanitize(value),
								event,
								cpuMs: Number.isFinite(trace.cpuTime) ? trace.cpuTime : null,
								eventWallMs: Number.isFinite(trace.wallTime)
									? trace.wallTime
									: null,
								outcome: trace.outcome
							}
						]
					: [];
			} catch {
				return [];
			}
		})
	)
);
const raw = sanitize(read('result.json'));
const direct = raw.entryMode === 'direct';
const unique = (values: any[]): any[] => [
	...new Map(values.map((value) => [value.event, value])).values()
];
const rows = raw.rows.map((row: any) => {
	const selected = telemetry.filter((event: any) => event.tag === row.tag);
	const owner = selected.filter(
		(event: any) => !['lane', 'echo', 'lane-close', 'entry'].includes(event.phase)
	);
	const lanes = selected.filter((event: any) => event.phase === 'lane');
	const entry = selected.filter((event: any) => event.phase === 'entry');
	const allCpu = selected.length > 0 && selected.every((event: any) => event.cpuMs !== null);
	const exclusive = selected.every((event: any) =>
		telemetry
			.filter((other: any) => other.event === event.event)
			.every((other: any) => other.tag === row.tag)
	);
	const sum = (entries: any[]) =>
		entries.length && entries.every((x) => x.cpuMs !== null)
			? unique(entries).reduce((value, entry) => value + entry.cpuMs, 0)
			: null;
	const expectedEvents =
		row.action === 'operation'
			? (raw.entryMode === 'separate' || !raw.entryMode ? 2 : 1) + (row.result?.frames ?? 0)
			: null;
	return {
		...row,
		telemetry: {
			observedEvents: unique(selected).length,
			expectedEvents,
			complete:
				!direct &&
				exclusive &&
				expectedEvents !== null &&
				unique(selected).length === expectedEvents &&
				allCpu,
			ownerCpuMs: exclusive ? sum(owner) : null,
			laneCpuMs: sum(lanes),
			entryCpuMs: exclusive ? sum(entry) : null,
			totalCpuMs: allCpu && exclusive && !direct ? sum(selected) : null
		}
	};
});
const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b),
		middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const summary = [];
for (const pages of [2, 32, 128])
	for (const width of [1, 2, 4, 8]) {
		const arms = [true, false].map((serial) => {
			const selected = rows.filter(
				(r: any) =>
					r.action === 'operation' &&
					r.pages === pages &&
					r.width === width &&
					r.serial === serial
			);
			const warm = selected.filter((r: any) => r.iteration > 0 && r.passed);
			const cpu = warm
				.filter((r: any) => r.telemetry.complete)
				.map((r: any) => r.telemetry.totalCpuMs);
			return {
				serial,
				attempts: selected.length,
				completed: selected.filter((r: any) => r.passed).length,
				firstUseWallMs: selected[0]?.wallMs ?? null,
				warmMedianWallMs:
					warm.length && warm.every((r: any) => typeof r.wallMs === 'number')
						? median(warm.map((r: any) => r.wallMs))
						: null,
				warmMedianOwnerAwaitMs:
					warm.length && !(direct && serial)
						? median(warm.map((r: any) => r.ownerAwaitMs))
						: null,
				warmMedianCpuMs: cpu.length ? median(cpu) : null,
				warmCpuSamples: cpu.length,
				warmRequestsPerOperation:
					warm.length && !direct
						? median(warm.map((r: any) => 2 + r.result.frames))
						: null,
				warmBytesPerOperation: warm.length
					? median(
							warm.map(
								(r: any) =>
									r.result.report.transportBytes.sent +
									r.result.report.transportBytes.received
							)
						)
					: null,
				warmRequestRateEquivalentUsd:
					warm.length && !direct
						? median(
								warm.map(
									(r: any) => 0.3 / 1e6 + ((1 + r.result.frames) * 0.15) / 1e6
								)
							)
						: null
			};
		});
		summary.push({
			memoryBytes: pages * 65536,
			width,
			arms,
			warmSpeedup: arms.every((a) => a.warmMedianWallMs !== null)
				? arms[0]!.warmMedianWallMs! / arms[1]!.warmMedianWallMs!
				: null
		});
	}
const cohorts = rows
	.filter((row: any) => ['cell', 'reentrant', 'direct'].includes(row.action))
	.map((row: any) => {
		const calls = rows.filter(
			(value: any) =>
				value.key === row.key && !['cell', 'reentrant', 'direct'].includes(value.action)
		);
		const operations = calls.filter(
			(value: any) => value.action === 'operation' && value.passed
		);
		const selected = unique(
			telemetry.filter((event: any) => event.tag.startsWith(`${row.key}-`))
		);
		const frames = operations.reduce(
			(total: number, value: any) => total + value.result.frames,
			0
		);
		const expectedEvents = direct ? 2 + frames + row.width * 2 : null;
		const complete =
			expectedEvents !== null &&
			selected.length === expectedEvents &&
			selected.every((event: any) => event.cpuMs !== null);
		const first = operations[0]?.result;
		const retained =
			operations.length > 0 &&
			operations.every(
				(value: any) =>
					value.result.module === first.module &&
					value.result.object === first.object &&
					value.result.instance === first.instance
			);
		const doRequests = direct ? 1 + frames + row.width * 2 : null;
		const eventDuration = selected
			.filter((event: any) => event.phase !== 'entry')
			.reduce((total: number, event: any) => total + (event.eventWallMs ?? 0), 0);
		const observedCpuMs = selected.reduce(
			(total: number, event: any) => total + (event.cpuMs ?? 0),
			0
		);
		return {
			key: row.key,
			pages: row.pages,
			width: row.width,
			serial: row.serial,
			exact:
				row.passed && operations.length === 4 && calls.every((value: any) => value.passed),
			completedOperations: operations.length,
			retainedIdentity: retained,
			identityIncludesInstanceNonce: Boolean(first?.instance),
			externalWallMs: row.wallMs,
			ownerAwaitMs: row.ownerAwaitMs,
			observedEvents: selected.length,
			expectedEvents,
			completeCpu: complete,
			observedCpuMs,
			cpuMs: complete ? observedCpuMs : null,
			cpuMsPerCompletedOperation:
				complete && operations.length ? observedCpuMs / operations.length : null,
			durableObjectRequests: doRequests,
			totalRequests: doRequests === null ? null : 1 + doRequests,
			requestsPerCompletedOperation:
				doRequests !== null && operations.length
					? (1 + doRequests) / operations.length
					: null,
			transportBytes: operations.reduce(
				(total: number, value: any) =>
					total +
					value.result.report.transportBytes.sent +
					value.result.report.transportBytes.received,
				0
			),
			requestRateEquivalentUsdPerCompletedOperation:
				doRequests !== null && operations.length
					? (0.3 / 1e6 + (doRequests * 0.15) / 1e6) / operations.length
					: null,
			observedRequestDurationProxyGbS: (eventDuration / 1000) * 0.128
		};
	});
for (const item of summary) {
	const cells = [true, false].map((serial) =>
		cohorts.find(
			(cell: any) =>
				cell.pages * 65536 === item.memoryBytes &&
				cell.width === item.width &&
				cell.serial === serial
		)
	);
	Object.assign(item, {
		instrumentedLifecycleSpeedup:
			direct && cells.every((cell) => cell?.exact)
				? cells[0]!.externalWallMs / cells[1]!.externalWallMs
				: null
	});
}
const before = read('meter-before.json'),
	after = read('meter-after.json');
const final = read('final.json');
const sha256 = (name: string) =>
	createHash('sha256')
		.update(readFileSync(join(run, name)))
		.digest('hex');
const result = {
	schema: 'folio.managed-phases.v1',
	entryMode: raw.entryMode ?? 'separate',
	capturedAt: new Date().toISOString(),
	environment: read('source.json'),
	sourceAfter: final.sourceAfter,
	baselineRestored: final.baselineRestored,
	sourceFiles: [
		'source.json',
		'result.json',
		'tail.jsonl',
		'meter-before.json',
		'meter-after.json'
	].map((path) => ({ role: path, sha256: sha256(path) })),
	rows,
	telemetry,
	cohorts,
	meter: { before, after, scope: 'account-wide; no experiment attribution' },
	summary,
	semantics: {
		cpu: 'platform tail; whole-millisecond resolution; event IDs deduplicated; null when incomplete',
		firstUse: 'first pool operation after an observed setup; no eviction forced',
		warm: 'operations 1-3; reuse must be confirmed by returned owner identity',
		await: 'I/O elapsed time; synchronous work may not advance the managed clock',
		requests: 'entry Worker plus owner RPC plus observed lane RPCs',
		directLifecycle:
			'setup including native oracle, four exact operations, diagnostic copy/echo phases and close',
		requestRateEquivalent:
			'hypothetical Paid overage rates before included allocation and unit rounding; not a bill',
		durationCost: null,
		accountPlan: 'Free',
		requestDurationProxy: 'observed DO request wall times times 0.128 GB; not billed duration',
		durationCostReason: 'tail wall and CPU do not measure object active billing intervals'
	}
};
writeFileSync(resolve(output, `${role}.json`), JSON.stringify(result, null, 2) + '\n', {
	flag: 'wx'
});
writeFileSync(
	resolve(output, `${role}.summary.json`),
	JSON.stringify(
		{
			baselineRestored: result.baselineRestored,
			completed: rows.filter((row: any) => row.action === 'operation' && row.passed).length,
			failures: rows.filter((row: any) => !row.passed).length,
			telemetryEvents: telemetry.length,
			uniqueTelemetryEvents: unique(telemetry).length,
			completeCpuCohorts: cohorts.filter((cohort: any) => cohort.completeCpu).length,
			completeCpuOperations: rows.filter(
				(row: any) => row.action === 'operation' && row.telemetry.complete
			).length,
			summary
		},
		null,
		2
	) + '\n',
	{ flag: 'wx' }
);
console.log(
	JSON.stringify({
		output,
		complete: rows.filter((row: any) => row.passed).length,
		failures: rows.filter((row: any) => !row.passed).length
	})
);
