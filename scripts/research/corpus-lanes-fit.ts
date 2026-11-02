import { readFileSync } from 'node:fs';
import { fitTwo } from '../../experiments/corpus-lanes/measure.ts';

// per-request lane cost and owner cost, fitted over the warm runs of rows written by `run`
const rows = readFileSync(process.argv[2]!, 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line))
	.filter((row) => row.warm && row.warm.requests && row.warm.regions === row.n);
const ids = [...new Set(rows.map((row) => row.id))];
for (const id of ids) {
	const mine = rows.filter((row) => row.id === id);
	const lane = mine.flatMap((row) =>
		row.warmRequests.map((r: any) => ({ x: 1, z: r.reads + r.writes, y: r.ms }))
	);
	const owner = mine.map((row) => ({
		x: row.warm.requests,
		z: row.warm.reads + row.warm.writes,
		y: row.warm.ownerMs
	}));
	try {
		const a = fitTwo(lane);
		const b = fitTwo(owner);
		console.log(
			JSON.stringify({
				id,
				runs: mine.length,
				laneFixedMsPerRequest: Number(a.a.toFixed(3)),
				laneNsPerTrackedAddress: Number((a.b * 1e6).toFixed(1)),
				ownerFixedMsPerRequest: Number(b.a.toFixed(3)),
				ownerNsPerTrackedAddress: Number((b.b * 1e6).toFixed(1))
			})
		);
	} catch (error) {
		console.log(JSON.stringify({ id, error: String(error) }));
	}
}
