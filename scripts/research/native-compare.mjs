// usage: node native-compare.mjs NATIVE_DIR ARMS_DIR [ARMS_DIR...] ; native parallel-for baseline against the wasm modes, per driver
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const [nativeDir, ...armDirs] = process.argv.slice(2);
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length
		? s.length % 2
			? s[(s.length - 1) / 2]
			: (s[s.length / 2 - 1] + s[s.length / 2]) / 2
		: NaN;
};
const native = new Map();
for (const file of readdirSync(nativeDir).filter((name) => /-\d\.jsonl$/.test(name))) {
	const id = file.replace(/-\d\.jsonl$/, '');
	const rows = readFileSync(`${nativeDir}/${file}`, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const row = rows.find((r) => r.speedup !== undefined);
	if (!row) continue;
	const cell = native.get(id) ?? { speedups: [], equal: true, serial: [] };
	cell.speedups.push(row.speedup);
	cell.serial.push(row.serialMs);
	cell.equal &&= row.equal;
	native.set(id, cell);
}
const wasm = new Map();
for (const dir of armDirs) {
	const failed = new Set();
	if (existsSync(`${dir}/failed.log`))
		for (const line of readFileSync(`${dir}/failed.log`, 'utf8').trim().split('\n')) {
			const [, arm, id] = line.split(' ');
			if (id) failed.add(`${id}|${arm}`);
		}
	for (const file of readdirSync(dir).filter((name) =>
		/^(automatic|forced|explicit|inplace)-.+-\d\.jsonl$/.test(name)
	)) {
		const [, arm, id] = file.match(/^(automatic|forced|explicit|inplace)-(.+)-\d\.jsonl$/);
		if (failed.has(`${id}|${arm}`)) continue;
		const samples = readFileSync(`${dir}/${file}`, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === 'sample');
		const byRound = new Map();
		for (const r of samples)
			(byRound.get(r.round) ?? byRound.set(r.round, {}).get(r.round))[r.arm] = r;
		const mine = samples.filter((r) => r.arm === arm && byRound.get(r.round)?.native);
		if (!mine.length) continue;
		const cell = wasm.get(id) ?? {};
		(cell[arm] ??= []).push(
			med(mine.map((r) => byRound.get(r.round).native.wallMs / r.wallMs))
		);
		wasm.set(id, cell);
	}
}
const ids = [...native.keys()].sort();
const best = (id) => {
	const cell = wasm.get(id) ?? {};
	return Math.max(1, ...Object.values(cell).map((s) => med(s)));
};
const geo = (values) => Math.exp(values.reduce((s, x) => s + Math.log(x), 0) / values.length);
console.log('| driver | native parallel-for | best wasm mode | wasm best over native |');
console.log('| --- | ---: | ---: | ---: |');
const rows = [];
for (const id of ids) {
	const n = native.get(id);
	const nat = n.equal ? med(n.speedups) : NaN;
	const w = best(id);
	rows.push({ id, nat, w });
	console.log(
		`| ${id} | ${n.equal ? nat.toFixed(2) : 'not equal'} | ${w.toFixed(2)} | ${n.equal ? (w / nat).toFixed(2) : '-'} |`
	);
}
const exact = rows.filter((r) => !Number.isNaN(r.nat));
console.log(
	`\nGeometric mean over the ${exact.length} drivers with equal native output: native parallel-for ${geo(exact.map((r) => r.nat)).toFixed(2)}, best exact wasm mode ${geo(exact.map((r) => r.w)).toFixed(2)}, wasm over native ${geo(exact.map((r) => r.w / r.nat)).toFixed(2)}.`
);
console.log(
	`Drivers with native speedup above 2: ${exact.filter((r) => r.nat > 2).length} of ${exact.length}; with the best wasm mode above 2: ${exact.filter((r) => r.w > 2).length}.`
);
