import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

type Trace = {
	logs: { message: string[] }[];
	cpuTime: number;
	wallTime: number;
	outcome: string;
};

export function events(text: string): Trace[] {
	const out: Trace[] = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escape = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (start < 0) {
			if (char === '{') {
				start = i;
				depth = 1;
			}
			continue;
		}
		if (quoted) {
			if (escape) escape = false;
			else if (char === '\\') escape = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === '{') depth++;
		else if (char === '}' && --depth === 0) {
			out.push(JSON.parse(text.slice(start, i + 1)));
			start = -1;
		}
	}
	assert.equal(start, -1, 'incomplete telemetry event');
	return out;
}

// wrangler tail prints concatenated JSON objects, one per invocation, with no separator
export async function analyzeTail(name: string) {
	assert.match(name, /^cfw-folio-[a-z0-9-]+$/);
	const directory = new URL(`./runs/${name}/`, import.meta.url);
	const { raw, summary } = JSON.parse(await readFile(new URL('result.json', directory), 'utf8'));
	const traces = events(await readFile(new URL('tail.jsonl', directory), 'utf8'));
	const lanes = traces.flatMap((trace) =>
		trace.logs.flatMap((log) =>
			log.message.flatMap((message) => {
				try {
					const value = JSON.parse(message);
					return value.probe === 'folio-cpu-lane'
						? [
								{
									...value,
									cpuMs: trace.cpuTime,
									eventWallMs: trace.wallTime,
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
	assert.ok(lanes.length <= 45);
	const rows = raw.cpu.rows
		.filter((row: any) => row.phase === 'measure')
		.map((row: any) => {
			const selected = lanes.filter(
				(lane) =>
					lane.nonce === raw.nonce && lane.lanes === row.lanes && lane.round === row.round
			);
			assert.ok(selected.length <= row.lanes);
			assert.equal(new Set(selected.map((lane) => lane.start)).size, selected.length);
			for (const lane of selected) {
				assert.equal(lane.outcome, 'ok');
				assert.ok(Number.isFinite(lane.cpuMs));
			}
			const cpuMs = selected.reduce((sum, lane) => sum + lane.cpuMs, 0);
			// platform integer milliseconds are rounded; subtract one full ms per event
			// for a conservative bound instead of presenting resolution as precision
			return {
				lanes: row.lanes,
				round: row.round,
				wallMs: row.wallMs,
				cpuMs,
				observedLaneEvents: selected.length,
				completeTelemetry: selected.length === row.lanes,
				cpuPerWall: cpuMs / row.wallMs,
				conservativeCpuOverlap: (cpuMs - selected.length) / (row.wallMs + 1),
				isolateCount: row.distinctIsolates,
				exact: row.exact
			};
		});
	const read = async (file: string) =>
		JSON.parse(await readFile(new URL(file, directory), 'utf8'));
	const result = {
		name,
		invocationsObserved: traces.length,
		laneEvents: lanes.length,
		summary,
		rows,
		baselineRestored:
			JSON.stringify(await read('baseline.json')) === JSON.stringify(await read('after.json'))
	};
	await writeFile(new URL('metrics.json', directory), `${JSON.stringify(result, null, 2)}\n`, {
		flag: 'wx'
	});
	return result;
}

if (import.meta.main) {
	console.log(JSON.stringify(await analyzeTail(process.argv[2] ?? ''), null, 2));
}
