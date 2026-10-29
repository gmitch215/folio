import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { operationCosts } from '../../../scripts/research/derive.ts';
import { createApi, credentials } from '../../lib/cloudflare.ts';

const [runArg, output] = process.argv.slice(2);
assert.ok(runArg && output, 'usage: measure.ts RUN_DIRECTORY OUTPUT.json');
const run = resolve(runArg);
const read = (name: string) => JSON.parse(readFileSync(join(run, name), 'utf8'));
const result = read('result.json');
assert.equal(result.entryMode, 'measure');
const { name, startedAt } = read('run.json');
const stored = join(run, 'stored-query.json');
if (!existsSync(stored)) {
	const api = createApi(
		credentials({
			FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
			FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
		})
	);
	const query = await api('/workers/observability/telemetry/query', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			queryId: `folio-measure-${crypto.randomUUID()}`,
			view: 'events',
			limit: 2000,
			timeframe: { from: Date.parse(startedAt) - 60000, to: Date.now() },
			parameters: {
				filterCombination: 'and',
				filters: [
					{ key: '$metadata.service', operation: 'eq', type: 'string', value: name }
				]
			}
		})
	});
	writeFileSync(stored, JSON.stringify(query, null, 2) + '\n', { flag: 'wx' });
}
const bytes = readFileSync(stored);
const records: any[] = JSON.parse(bytes.toString()).events?.events ?? [];
const invocations = new Map<string, any[]>();
for (const record of records) {
	const id = record.$metadata.requestId;
	invocations.set(id, [...(invocations.get(id) ?? []), record]);
}
const events = [...invocations.values()]
	.map((group) => ({
		cpuMs: group.find((record) => typeof record.$workers?.cpuTimeMs === 'number')?.$workers
			.cpuTimeMs as number | undefined,
		tags: group
			.filter((record) => record.source?.probe === 'folio-phases')
			.map((record) => String(record.source.tag))
	}))
	.filter((event) => event.tags.length);
const cohorts = result.rows.map((row: any) => {
	const rows: any[] = row.result.rows;
	const operations = rows.filter((inner) => inner.action === 'operation' && inner.passed);
	assert.equal(operations.length, row.operations, 'an operation failed');
	const frames = operations.reduce((sum, op) => sum + op.result.frames, 0);
	const selected = events.filter((event) =>
		event.tags.some((tag) => tag.startsWith(`${row.key}-`))
	);
	const expected = 2 + frames + row.width;
	const complete =
		selected.length === expected && selected.every((event) => event.cpuMs !== undefined);
	return {
		pages: row.pages,
		serial: row.serial,
		operations: row.operations,
		repeat: row.repeat,
		observedEvents: selected.length,
		expectedEvents: expected,
		cpuMs: complete ? selected.reduce((sum, event) => sum + event.cpuMs!, 0) : null,
		wallMs: row.wallMs as number,
		setupAwaitMs: rows.find((inner) => inner.action === 'setup').ownerAwaitMs as number,
		ops: operations.map((op) => ({
			ownerAwaitMs: op.ownerAwaitMs as number,
			sent: op.result.report.transportBytes?.sent ?? 0,
			received: op.result.report.transportBytes?.received ?? 0,
			frames: op.result.frames as number,
			mode: op.result.report.mode,
			replayed: op.result.report.replayed,
			fallbacks: op.result.report.fallbacks,
			transportFallbacks: op.result.report.transportFallbacks
		}))
	};
});
const summary = {
	schema: 'folio.managed-operations.v1',
	storedSha256: createHash('sha256').update(bytes).digest('hex'),
	invocations: cohorts.length,
	completeCpuInvocations: cohorts.filter((cohort: any) => cohort.cpuMs !== null).length,
	scope: 'width four, 64 regions of 2,097,152 rounds, direct calls in one invocation; costs are differences between invocations that ran 0, 1 and 5 operations after the same setup',
	costs: operationCosts(cohorts),
	invocationsDetail: cohorts
};
writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(
	JSON.stringify({
		invocations: summary.invocations,
		completeCpu: summary.completeCpuInvocations,
		mismatched: cohorts
			.filter((cohort: any) => cohort.observedEvents !== cohort.expectedEvents)
			.map((cohort: any) => [cohort.observedEvents, cohort.expectedEvents])
	})
);
