import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const ids = [
	...new Set(
		readdirSync(dir)
			.filter((f) => f.endsWith('.jsonl'))
			.map((f) => f.replace(/-\d\.jsonl$/, ''))
	)
].sort();
console.log(
	'| program | call | record sizes | automatic speedup, median of 3 sessions | mode in the most sessions |'
);
console.log('| --- | ---: | --- | ---: | --- |');
for (const id of ids) {
	const sessions = readdirSync(dir)
		.filter((f) => f.startsWith(id + '-') && f.endsWith('.jsonl'))
		.map((f) =>
			readFileSync(`${dir}/${f}`, 'utf8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l))
				.filter((r) => r.kind === 'call')
		);
	for (let call = 0; call < 18; call++) {
		const rows = sessions.map((s) => s[call]).filter(Boolean);
		if (!rows.length) continue;
		const modes = rows.map((r) => r.mode);
		const mode = modes.sort(
			(a, b) => modes.filter((x) => x === b).length - modes.filter((x) => x === a).length
		)[0];
		console.log(
			`| ${id} | ${call} | ${rows[0].sizes} | ${med(rows.map((r) => r.speedup)).toFixed(2)} | ${mode} |`
		);
	}
}
