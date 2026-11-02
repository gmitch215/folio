import { readFileSync } from 'node:fs';

// paired summary of c21-bench timed files: per arm, speedup = native wall / arm wall per round
const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rows = [];
for (const file of process.argv.slice(2)) {
	const lines = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	const env = lines[0];
	const samples = lines.filter((x) => x.kind === 'sample');
	const arms = [...new Set(samples.filter((s) => s.arm !== 'native').map((s) => s.case))];
	for (const arm of arms) {
		const mine = samples.filter((s) => s.case === arm && s.arm === arm);
		const base = samples.filter((s) => s.case === arm && s.arm === 'native');
		const rounds = mine.map((s) => s.round);
		const speed = rounds.map(
			(r) => base.find((b) => b.round === r).wallMs / mine.find((m) => m.round === r).wallMs
		);
		const cpu = rounds.map(
			(r) => mine.find((m) => m.round === r).cpuMs / base.find((b) => b.round === r).cpuMs
		);
		const loads = [...mine, ...base].map((s) => s.load[0]);
		const med = median(speed);
		const spread = (Math.max(...speed) - Math.min(...speed)) / med;
		const last = mine[mine.length - 1]?.report ?? {};
		rows.push({
			id: env.configuration.id,
			n: env.configuration.n,
			arm,
			rounds: rounds.length,
			nativeMs: median(base.map((b) => b.wallMs)),
			armMs: median(mine.map((m) => m.wallMs)),
			speedup: med,
			min: Math.min(...speed),
			max: Math.max(...speed),
			spread,
			inconclusive: spread > 0.4,
			cpuRatio: median(cpu),
			loadMin: Math.min(...loads),
			loadMax: Math.max(...loads),
			passed: mine.every((s) => s.passed),
			stop: last.stopped ?? last.reason,
			regions: last.regions,
			replayed: last.replayed,
			tasks: last.tasks
		});
	}
}
if (process.env.JSON) console.log(JSON.stringify(rows));
else
	for (const r of rows)
		console.log(
			[
				r.id.padEnd(24),
				r.arm.padEnd(10),
				'native=' + r.nativeMs.toFixed(2) + 'ms',
				'arm=' + r.armMs.toFixed(2) + 'ms',
				'speedup=' + r.speedup.toFixed(2),
				'[' + r.min.toFixed(2) + ',' + r.max.toFixed(2) + ']',
				'spread=' + r.spread.toFixed(2) + (r.inconclusive ? ' INCONCLUSIVE' : ''),
				'cpu=' + r.cpuRatio.toFixed(2),
				'load=' + r.loadMin.toFixed(1) + '-' + r.loadMax.toFixed(1),
				'stop=' + (r.stop ?? '-'),
				'ok=' + r.passed
			].join(' ')
		);
