import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const out = process.argv[3];
const rows = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
const runs = rows.filter((row) => row.path.startsWith('/run?'));
const ready = rows.filter((row) => row.path.startsWith('/ready'));
const writeSegments = 576;

const stats = (xs) => {
	const sorted = [...xs].sort((a, b) => a - b);
	const sum = xs.reduce((a, b) => a + b, 0);
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return {
		n: xs.length,
		sumS: +(sum / 1000).toFixed(3),
		mean: +(sum / xs.length).toFixed(1),
		p50: +at(0.5).toFixed(1),
		p10: +at(0.1).toFixed(1),
		p90: +at(0.9).toFixed(1),
		min: +sorted[0].toFixed(1),
		max: +sorted[sorted.length - 1].toFixed(1)
	};
};

const walls = runs.map((row) => row.wallMs);
const write = walls.slice(0, writeSegments);
const read = walls.slice(writeSegments);
const first = walls[0];
const lane = (n) => runs.filter((row) => row.path.includes(`lane=${n}`)).map((row) => row.wallMs);
const drift = (xs, parts) => {
	const size = Math.floor(xs.length / parts);
	return Array.from(
		{ length: parts },
		(_, i) => +(xs.slice(i * size, (i + 1) * size).reduce((a, b) => a + b, 0) / size).toFixed(1)
	);
};

const result = {
	runRequests: runs.length,
	all: stats(walls),
	firstSegmentMs: +first.toFixed(1),
	writePhase: stats(write),
	readPhase: stats(read),
	perOpMsWrite: +(write.reduce((a, b) => a + b, 0) / (write.length * 16)).toFixed(2),
	perOpMsRead: +(read.reduce((a, b) => a + b, 0) / (read.length * 16)).toFixed(2),
	lane0: stats(lane(0)),
	lane1: stats(lane(1)),
	laneByPhase: Object.fromEntries(
		[0, 1].flatMap((n) => [
			[
				`lane${n}Write`,
				stats(
					runs
						.slice(0, writeSegments)
						.filter((row) => row.path.includes(`lane=${n}`))
						.map((row) => row.wallMs)
				)
			],
			[
				`lane${n}Read`,
				stats(
					runs
						.slice(writeSegments)
						.filter((row) => row.path.includes(`lane=${n}`))
						.map((row) => row.wallMs)
				)
			]
		])
	),
	driftWriteQuarters: drift(write, 4),
	driftReadQuarters: drift(read, 4),
	readyOk: ready.filter((row) => row.status === 200).map((row) => +row.wallMs.toFixed(1)),
	ready404: ready.filter((row) => row.status === 404).map((row) => +row.wallMs.toFixed(1)),
	verifyMs: rows
		.filter((row) => row.path.startsWith('/verify'))
		.map((row) => +row.wallMs.toFixed(1)),
	clearMs: rows
		.filter((row) => row.path.startsWith('/clear'))
		.map((row) => +row.wallMs.toFixed(1))
};
const text = JSON.stringify(result, null, 1) + '\n';
if (out) writeFileSync(out, text, { flag: 'wx' });
else process.stdout.write(text);
