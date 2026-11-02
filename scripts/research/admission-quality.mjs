// usage: node admission-quality.mjs DIR [DIR...] ; per-driver arm speedups, the admission confusion matrix,
// regret against the best measured mode, and a fixed-cost planner fitted on a deterministic split
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const arms = ['automatic', 'forced', 'explicit', 'inplace'];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length
		? s.length % 2
			? s[(s.length - 1) / 2]
			: (s[s.length / 2 - 1] + s[s.length / 2]) / 2
		: NaN;
};
const quantile = (a, q) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : NaN;
};
const byRoundHasNative = (samples, round) =>
	samples.some((row) => row.round === round && row.arm === 'native');
const drivers = new Map();
const failed = new Set();
for (const dir of process.argv.slice(2)) {
	if (existsSync(`${dir}/failed.log`))
		for (const line of readFileSync(`${dir}/failed.log`, 'utf8').trim().split('\n')) {
			const [, arm, id] = line.split(' ');
			if (id) failed.add(`${id}|${arm}`);
		}
	for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
		const m = file.match(/^(automatic|forced|explicit|inplace)-(.+)-(\d)\.jsonl$/);
		if (!m) continue;
		const [, arm, id] = m;
		const rows = readFileSync(`${dir}/${file}`, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const samples = rows.filter((row) => row.kind === 'sample');
		const mine = samples.filter(
			(row) => row.arm === arm && byRoundHasNative(samples, row.round)
		);
		if (!mine.length) continue;
		const byRound = new Map();
		for (const row of samples) {
			const entry = byRound.get(row.round) ?? {};
			entry[row.arm] = row;
			byRound.set(row.round, entry);
		}
		const driver = drivers.get(id) ?? {
			id,
			n: rows[0].configuration?.n,
			native: [],
			cells: {}
		};
		driver.native.push(
			...samples.filter((row) => row.arm === 'native').map((row) => row.wallMs)
		);
		const cell = (driver.cells[arm] ??= { sessions: [], exact: true, admitted: [] });
		cell.sessions.push(
			med(mine.map((row) => byRound.get(row.round).native.wallMs / row.wallMs))
		);
		cell.exact &&= mine.every((row) => row.passed);
		if (arm === 'automatic')
			cell.admitted.push(
				...mine.map((row) =>
					(row.report?.admission?.admitted ?? row.report?.mode !== 'serial') ? 1 : 0
				)
			);
		drivers.set(id, driver);
	}
}
const ids = [...drivers.keys()].sort();
const speed = (id, arm) => {
	const cell = drivers.get(id).cells[arm];
	return cell && !failed.has(`${id}|${arm}`) ? med(cell.sessions) : NaN;
};
const wins = (id, arm) => {
	const cell = drivers.get(id).cells[arm];
	return cell
		? cell.sessions.filter((x) => x > 1).length >= Math.ceil(cell.sessions.length * 0.67) &&
				med(cell.sessions) > 1
		: false;
};
const rows = ids.map((id) => {
	const d = drivers.get(id);
	const serialMs = med(d.native);
	return {
		id,
		serialMs,
		micros: (serialMs * 1000) / d.n,
		auto: speed(id, 'automatic'),
		forced: speed(id, 'forced'),
		explicit: speed(id, 'explicit'),
		inplace: speed(id, 'inplace'),
		label: wins(id, 'forced') || wins(id, 'automatic'),
		admitted: d.cells.automatic ? med(d.cells.automatic.admitted) >= 0.5 : false
	};
});
const f = (x) => (Number.isNaN(x) ? '-' : x.toFixed(2));
console.log(
	'| driver | serial ms | us per record | automatic | forced | explicit | in place | route can win | auto admitted |'
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
for (const r of rows)
	console.log(
		`| ${r.id} | ${r.serialMs.toFixed(1)} | ${r.micros.toFixed(1)} | ${f(r.auto)} | ${f(r.forced)} | ${f(r.explicit)} | ${f(r.inplace)} | ${r.label ? 'yes' : 'no'} | ${r.admitted ? 'yes' : 'no'} |`
	);

const count = (predicate) => rows.filter(predicate).length;
const tp = count((r) => r.admitted && r.label),
	fp = count((r) => r.admitted && !r.label),
	fn = count((r) => !r.admitted && r.label),
	tn = count((r) => !r.admitted && !r.label);
console.log(
	'\nAdmission against the label (a tracked route beats serial in at least two thirds of sessions):\n'
);
console.log('| | route can win | route cannot win |');
console.log('| --- | ---: | ---: |');
console.log(`| automatic admits | ${tp} | ${fp} |`);
console.log(`| automatic refuses | ${fn} | ${tn} |`);

// time of each policy with serial = 1; the oracle takes the best measured tracked mode
const timeOf = (r, policy) => {
	const forced = Number.isNaN(r.forced) ? Infinity : 1 / r.forced;
	const auto = Number.isNaN(r.auto) ? Infinity : 1 / r.auto;
	if (policy === 'serial') return 1;
	if (policy === 'automatic') return auto;
	if (policy === 'forced') return forced;
	return Math.min(1, forced, auto);
};
const regret = (set, time) => set.map((r) => time(r) / timeOf(r, 'oracle') - 1);
const weighted = (set, time) => {
	const total = set.reduce((sum, r) => sum + r.serialMs, 0);
	return (
		set.reduce((sum, r) => sum + r.serialMs * time(r), 0) /
			set.reduce((sum, r) => sum + r.serialMs * timeOf(r, 'oracle'), 0) -
			1 || (total ? 0 : 0)
	);
};
const summary = (name, set, time) => {
	const rg = regret(set, time);
	return `| ${name} | ${set.length} | ${(rg.reduce((a, b) => a + b, 0) / rg.length).toFixed(3)} | ${quantile(rg, 0.9).toFixed(3)} | ${Math.max(...rg).toFixed(3)} | ${weighted(set, time).toFixed(3)} |`;
};
console.log(
	'\nRegret against the best measured tracked mode (extra time as a fraction of the oracle time):\n'
);
console.log('| policy | loops | mean | 90th percentile | max | weighted by serial time |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const policy of rows.some((r) => Number.isNaN(r.forced))
	? ['automatic', 'serial']
	: ['automatic', 'forced', 'serial'])
	console.log(summary(policy, rows, (r) => timeOf(r, policy)));

// a fixed-cost planner: admit when the serial work is at least theta ms and each record at least phi microseconds
const test = rows.filter((_, index) => index % 3 === 2);
const train = rows.filter((_, index) => index % 3 !== 2);
const planner = (theta, phi) => (r) => (r.serialMs >= theta && r.micros >= phi ? 1 / r.forced : 1);
// AQ_FIT=0 skips the fitted rules, for a set too small to split
const fitted = (run) => process.env.AQ_FIT !== '0' && run();
fitted(() => {
	let best;
	for (const theta of [0, 0.5, 1, 2.5, 5, 10, 20, 50, 100, 200])
		for (const phi of [0, 1, 5, 10, 20, 50, 100, 200, 500, 1000, 5000]) {
			const rg = regret(train, planner(theta, phi));
			const mean = rg.reduce((a, b) => a + b, 0) / rg.length;
			if (!best || mean < best.mean - 1e-9) best = { theta, phi, mean };
		}
	console.log(
		`\nFixed-cost planner (admit when serial work >= ${best.theta} ms and cost per record >= ${best.phi} us, fitted on ${train.length} loops, tested on ${test.length}):\n`
	);
	console.log('| policy | loops | mean | 90th percentile | max | weighted by serial time |');
	console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
	console.log(summary('planner, train', train, planner(best.theta, best.phi)));
	console.log(summary('planner, test', test, planner(best.theta, best.phi)));
	console.log(summary('automatic, train', train, (r) => timeOf(r, 'automatic')));
	console.log(summary('automatic, test', test, (r) => timeOf(r, 'automatic')));
	const picked = rows.filter((r) => r.serialMs >= best.theta && r.micros >= best.phi);
	console.log(
		`\nThe planner admits ${picked.length} of ${rows.length} loops and ${picked.filter((r) => r.label).length} of the ${rows.filter((r) => r.label).length} that can win; automatic admits ${tp + fp} and ${tp}.`
	);
	console.log(
		`Test split: loops at sorted positions 3, 6, 9 and so on (${test.map((r) => r.id).join(', ')}).`
	);
});

const geomean = (values) =>
	Math.exp(values.reduce((sum, x) => sum + Math.log(x), 0) / values.length);
const exactOr = (x) => (Number.isNaN(x) ? 1 : x);
console.log(
	'\nGeometric mean speedup over all loops (a mode that failed its output check or does not apply counts as serial, 1.00):\n'
);
console.log('| mode | geometric mean | loops above 1.0 |');
console.log('| --- | ---: | ---: |');
for (const [name, pick] of [
	['automatic', (r) => r.auto],
	['forced', (r) => r.forced],
	['explicit private contexts', (r) => r.explicit],
	['in place, caller declares independence', (r) => r.inplace],
	[
		'best exact mode per loop',
		(r) =>
			Math.max(1, exactOr(r.auto), exactOr(r.forced), exactOr(r.explicit), exactOr(r.inplace))
	]
]) {
	const values = rows.map((r) =>
		Math.max(exactOr(pick(r)), name.startsWith('best') ? 1 : 0.0001)
	);
	console.log(
		`| ${name} | ${geomean(values).toFixed(2)} | ${values.filter((x) => x > 1).length} |`
	);
}

// the first tracked batch also limits the loss of a wrong admit: compare the same loops with and without it
const wrong = rows.filter((r) => r.admitted && !r.label);
const stat = (values) =>
	`${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)} (worst ${Math.min(...values).toFixed(2)})`;
console.log(
	`\nThe ${wrong.length} loops automatic admitted where no tracked route wins, speedup mean and worst:\n`
);
console.log('| route | speedup |');
console.log('| --- | --- |');
console.log(
	`| automatic, with the first batch and the bound stop | ${stat(wrong.map((r) => r.auto))} |`
);
console.log(`| forced, dispatching without them | ${stat(wrong.map((r) => r.forced))} |`);

// the same serial-work gate in front of the protected route: admit by the gate, then behave as automatic does
// a loop the gate refuses still pays the refusal path automatic pays: the median time ratio of the loops it refused
const refusedRows = rows.filter((r) => !r.admitted && !Number.isNaN(r.auto));
const refuseCost = med(refusedRows.map((r) => 1 / r.auto));
const guarded = (theta, phi) => (r) =>
	r.serialMs >= theta && r.micros >= phi ? 1 / r.auto : refuseCost;
fitted(() => {
	let bestGuard;
	for (const theta of [0, 0.5, 1, 2.5, 3, 4, 5, 7, 10, 20, 50])
		for (const phi of [0, 1, 5, 10, 20, 50, 100]) {
			const rg = regret(train, guarded(theta, phi));
			const mean = rg.reduce((a, b) => a + b, 0) / rg.length;
			if (!bestGuard || mean < bestGuard.mean - 1e-9) bestGuard = { theta, phi, mean };
		}
	console.log(
		`\nA serial-work gate in front of the protected route (serial work >= ${bestGuard.theta} ms and cost per record >= ${bestGuard.phi} us, fitted on the same ${train.length} loops):\n`
	);
	console.log('| policy | loops | mean | 90th percentile | max | weighted by serial time |');
	console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
	console.log(
		summary('gate then protected, train', train, guarded(bestGuard.theta, bestGuard.phi))
	);
	console.log(
		summary('gate then protected, test', test, guarded(bestGuard.theta, bestGuard.phi))
	);
	console.log(summary('automatic, train', train, (r) => timeOf(r, 'automatic')));
	console.log(summary('automatic, test', test, (r) => timeOf(r, 'automatic')));
});

// AQ_GATE="THETA_MS,PHI_US" scores a gate fixed beforehand on these loops with no fitting
if (process.env.AQ_GATE) {
	const [theta, phi] = process.env.AQ_GATE.split(',').map(Number);
	const fixed = guarded(theta, phi);
	console.log(
		`\nFixed gate, no fitting (serial work >= ${theta} ms and cost per record >= ${phi} us, refusal cost ${refuseCost.toFixed(3)}):\n`
	);
	console.log(
		'| driver | serial ms | us per record | gate admits | gate time | automatic time | automatic wins by more than 1.05x and the gate refuses |'
	);
	console.log('| --- | ---: | ---: | --- | ---: | ---: | --- |');
	let missed = 0;
	for (const r of rows) {
		const admits = r.serialMs >= theta && r.micros >= phi;
		const miss = !admits && r.auto > 1.05;
		if (miss) missed++;
		console.log(
			`| ${r.id} | ${r.serialMs.toFixed(1)} | ${r.micros.toFixed(1)} | ${admits ? 'yes' : 'no'} | ${fixed(r).toFixed(3)} | ${(1 / r.auto).toFixed(3)} | ${miss ? 'yes' : 'no'} |`
		);
	}
	console.log(
		`\n${summary('gate', rows, fixed)}\n${summary('automatic', rows, (r) => timeOf(r, 'automatic'))}\nWinners the gate misses: ${missed}.`
	);
}
