import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { digest } from './environment.ts';

type Row = Record<string, any>;

const count = (reasons: string[]) => {
	const counts: Record<string, number> = {};
	for (const reason of reasons) {
		const key = reason
			.replace(/\(.*\)/, '')
			.replace(/\d[\d,]*/g, 'N')
			.trim();
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(
		Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	);
};

/** Counts the analysis reasons that keep each corpus kernel out of automatic extraction. */
export function blockerHistogram(rows: Row[]) {
	const coverage = rows.filter((row) => row.kind === 'coverage');
	assert.ok(coverage.length, 'no coverage rows');
	return {
		schema: 'folio.blockers.v1',
		kernels: coverage.length,
		originalModule: count(coverage.flatMap((row) => row.original.reasons)),
		admission: count(coverage.flatMap((row) => row.original.controlReasons)),
		sharedBitOnly: count(coverage.flatMap((row) => row.sharedDiagnostic.reasons)),
		checkpointRefusals: count(coverage.flatMap((row) => row.checkpointRefusals))
	};
}

/** Compares each cell's setup identity with later successful operations and counts the evictions. */
export function stateLoss(studies: Record<string, Row>) {
	const result: Record<string, unknown> = {};
	for (const [name, record] of Object.entries(studies)) {
		const rows: Row[] = record.rows;
		const failures = rows.filter((row) => row.passed === false || row.error != null);
		const cells = new Map<string, Row[]>();
		for (const row of rows)
			if (row.result?.module != null)
				cells.set(row.key, [...(cells.get(row.key) ?? []), row]);
		let sameModule = 0,
			otherModule = 0,
			otherObject = 0;
		for (const group of cells.values()) {
			const setup = group.find((row) => row.action === 'setup');
			if (!setup) continue;
			for (const row of group.filter((item) => item.action !== 'setup')) {
				if (row.result.module === setup.result.module) sameModule++;
				else otherModule++;
				if (row.result.object !== setup.result.object) otherObject++;
			}
		}
		const native = failures.filter((row) => row.serial === true).length;
		const messages: Record<string, number> = {};
		for (const row of failures) {
			const message = String(row.error ?? row.failure ?? row.result?.error ?? '').slice(
				0,
				80
			);
			messages[message] = (messages[message] ?? 0) + 1;
		}
		result[name] = {
			cells: cells.size,
			failures: failures.length,
			failuresInNativeCells: native,
			failuresInAutomaticCells: failures.length - native,
			failureMessages: messages,
			laterOperationsSameModule: sameModule,
			laterOperationsOtherModule: otherModule,
			laterOperationsOtherObject: otherObject
		};
	}
	return {
		schema: 'folio.state-loss.v1',
		scope: 'Module identifiers are not isolate identities; object identifiers are routing identities.',
		studies: result
	};
}

/** Per-cell paired medians across independent sessions, and what the idle pools of the same session cost. */
export function sessionSpread(sessions: Row[]) {
	const medians = (cell: string) =>
		sessions.map((summary) => summary.groups[cell].folio.pairedSpeedup.median as number);
	const cells = Object.keys(sessions[0]!.groups);
	const middle = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b),
			half = sorted.length >> 1;
		return sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
	};
	const spread = Object.fromEntries(
		cells.map((cell) => {
			const values = medians(cell);
			return [
				cell,
				{
					perSession: values,
					median: middle(values),
					min: Math.min(...values),
					max: Math.max(...values),
					maxOverMin: Math.max(...values) / Math.min(...values)
				}
			];
		})
	);
	const idleEffect = Object.fromEntries(
		cells
			.filter((cell) => cell.endsWith('-idle'))
			.map((cell) => {
				const clean = cell.replace(/-idle$/, '');
				return [
					clean,
					{
						cleanMedian: spread[clean]!.median,
						idleMedian: spread[cell]!.median,
						idleOverClean: spread[cell]!.median / spread[clean]!.median
					}
				];
			})
	);
	return {
		schema: 'folio.session-spread.v1',
		sessions: sessions.length,
		cells: spread,
		idleEffect
	};
}

type Cohort = {
	pages: number;
	serial: boolean;
	operations: number;
	cpuMs: number | null;
	wallMs: number;
	setupAwaitMs: number;
	ops: { ownerAwaitMs: number; sent: number; received: number; frames: number }[];
};

const centre = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b),
		half = sorted.length >> 1;
	return sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/** First-use and steady-state cost per operation from invocations that ran 0, 1 and N operations after the same setup. */
export function operationCosts(cohorts: Cohort[]) {
	const keys = [...new Set(cohorts.map((cohort) => `${cohort.pages}/${cohort.serial}`))].sort();
	return Object.fromEntries(
		keys.map((key) => {
			const cell = cohorts.filter((cohort) => `${cohort.pages}/${cohort.serial}` === key);
			const counts = [...new Set(cell.map((cohort) => cohort.operations))].sort(
				(a, b) => a - b
			);
			const [none, one, many] = counts as [number, number, number];
			assert.equal(none, 0);
			const at = (operations: number, pick: (cohort: Cohort) => number | null) => {
				const values = cell
					.filter((cohort) => cohort.operations === operations)
					.map(pick)
					.filter((value): value is number => value !== null);
				return values.length ? centre(values) : null;
			};
			const difference = (pick: (cohort: Cohort) => number | null) => {
				const a = at(none, pick),
					b = at(one, pick),
					c = at(many, pick);
				return {
					setup: a,
					firstUse: a === null || b === null ? null : b - a,
					steady: b === null || c === null ? null : (c - b) / (many - one)
				};
			};
			const operations = cell.flatMap((cohort) =>
				cohort.ops.map((op, index) => ({ op, index }))
			);
			const first = operations.filter(({ index }) => index === 0).map(({ op }) => op);
			const later = operations.filter(({ index }) => index > 0).map(({ op }) => op);
			return [
				key,
				{
					invocations: cell.length,
					invocationsWithCpu: cell.filter((cohort) => cohort.cpuMs !== null).length,
					cpuMs: difference((cohort) => cohort.cpuMs),
					wallMs: difference((cohort) => cohort.wallMs),
					ownerAwaitMs: {
						firstOperation: first.length
							? centre(first.map((op) => op.ownerAwaitMs))
							: null,
						laterOperation: later.length
							? centre(later.map((op) => op.ownerAwaitMs))
							: null
					},
					bytesPerOperation: {
						sent: operations.length
							? centre(operations.map(({ op }) => op.sent))
							: null,
						received: operations.length
							? centre(operations.map(({ op }) => op.received))
							: null
					},
					lanePerOperation: operations.length
						? centre(operations.map(({ op }) => op.frames))
						: null
				}
			];
		})
	);
}

if (import.meta.main) {
	const [kind, output, ...inputs] = process.argv.slice(2);
	if (!kind || !output || !inputs.length)
		throw new Error('usage: derive.ts blockers|state-loss|session-spread OUTPUT.json INPUT...');
	const raw = inputs.map((input) => readFileSync(input));
	const hashes = raw.map(digest);
	let result: Record<string, unknown>;
	if (kind === 'blockers')
		result = blockerHistogram(
			raw.flatMap((bytes) =>
				bytes
					.toString()
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			)
		);
	else if (kind === 'state-loss')
		result = stateLoss(
			Object.fromEntries(
				inputs.map((input, index) => [
					input
						.split('/')
						.at(-1)!
						.replace(/\.json$/, ''),
					JSON.parse(raw[index]!.toString())
				])
			)
		);
	else if (kind === 'session-spread')
		result = sessionSpread(raw.map((bytes) => JSON.parse(bytes.toString())));
	else throw new Error(`unknown kind: ${kind}`);
	writeFileSync(output, JSON.stringify({ ...result, inputSha256: hashes }, null, 2) + '\n');
	console.log(JSON.stringify({ kind, inputs: inputs.length }));
}
