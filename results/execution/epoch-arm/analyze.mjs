// usage: node analyze.mjs   (reads raw-rows.json and counts.json in this directory)
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./raw-rows.json', import.meta.url), 'utf8'));
const counts = JSON.parse(readFileSync(new URL('./counts.json', import.meta.url), 'utf8'));
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
for (const route of [...new Set(rows.map((r) => r.route))]) {
	const rr = rows.filter((r) => r.route === route);
	const native = rr.filter((r) => r.arm === 'native');
	const hash = new Map(native.map((r) => [r.rep, r.normalizedSha256]));
	for (const arm of ['ep-heap32', 'r-heap32']) {
		const ar = rr.filter((r) => r.arm === arm);
		const ratios = ar.map((r) => r.requestMs / native.find((n) => n.rep === r.rep).requestMs - 1);
		const bad = ar.filter((r) => r.normalizedSha256 !== hash.get(r.rep)).length;
		console.log(route, arm, 'tau', median(ratios).toFixed(3), 'n', ar.length, 'html mismatches', bad);
	}
}
for (const c of counts.filter((x) => x.kind === 'translated-count' && x.run === 'e1')) {
	const k = c.counts;
	console.log(
		c.route,
		c.label,
		'group checks in arena',
		(k.garena / k.gchk).toFixed(3),
		'per-access outside arena',
		(k.miss / k.checked).toFixed(3),
		'accesses per group check',
		(k.group / k.gchk).toFixed(1)
	);
}
