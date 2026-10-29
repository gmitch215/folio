import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [source, evidence, output] = process.argv.slice(2);
assert.ok(source && evidence && output, 'usage: stored.ts RESPONSE_JSON EVIDENCE_JSON OUTPUT_JSON');
const bytes = readFileSync(source);
const response = JSON.parse(bytes.toString()).response;
const complete = JSON.parse(readFileSync(evidence, 'utf8'));
const records: any[] = response.events.events;
const groups = new Map<string, any[]>();
for (const record of records) {
	const key = record.$metadata.requestId;
	const group = groups.get(key) ?? [];
	group.push(record);
	groups.set(key, group);
}
const invocations = [...groups.values()]
	.map((group, event) => {
		const cpu = group.find((record) => typeof record.$workers?.cpuTimeMs === 'number');
		return {
			event,
			cpuMs: cpu?.$workers.cpuTimeMs ?? null,
			wallMs: cpu?.$workers.wallTimeMs ?? null,
			logs: group
				.filter((record) => record.source.probe === 'folio-phases')
				.map((record) => ({ tag: record.source.tag, phase: record.source.phase }))
		};
	})
	.filter((record) => record.logs.length);
const cohorts = complete.cohorts.map((cohort: any) => {
	const selected = invocations.filter((record) =>
		record.logs.some((log) => log.tag.startsWith(`${cohort.key}-`))
	);
	const exact =
		selected.length === cohort.expectedEvents &&
		selected.every((record) => record.cpuMs !== null);
	return {
		key: cohort.key,
		pages: cohort.pages,
		width: cohort.width,
		serial: cohort.serial,
		expectedEvents: cohort.expectedEvents,
		observedEvents: selected.length,
		completeCpu: exact,
		cpuMs: exact ? selected.reduce((sum, record) => sum + record.cpuMs, 0) : null,
		cpuMsPerCompletedOperation: exact
			? selected.reduce((sum, record) => sum + record.cpuMs, 0) / cohort.completedOperations
			: null
	};
});
const result = {
	schema: 'folio.managed-stored-telemetry.v1',
	sourceSha256: createHash('sha256').update(bytes).digest('hex'),
	evidenceSha256: createHash('sha256').update(readFileSync(evidence)).digest('hex'),
	statistics: response.statistics,
	apiEvents: records.length,
	invocations,
	cohorts,
	semantics:
		'stored invocation CPU joined by request identity and deduplicated; full instrumented lifecycle, not per-phase CPU'
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
	JSON.stringify({
		completeCpuCohorts: cohorts.filter((cohort: any) => cohort.completeCpu).length,
		cohorts
	})
);
