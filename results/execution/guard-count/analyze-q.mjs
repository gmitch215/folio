// reads the run JSON copies in raw/ and writes results-draft/raw-rows.json and results-draft/summary.json.
// the rows keep counts, hashes, module identity and timing only; no paths, accounts or site names.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = { admin: 'admin', front: 'front' };
const FILES = [
	['admin.nativeplaina1.json', 'admin', 'plain', 'a1'],
	['front.nativeplaina1.json', 'front', 'plain', 'a1'],
	['admin.nativecounta2.json', 'admin', 'count', 'a2'],
	['front.nativecounta2.json', 'front', 'count', 'a2'],
	['admin.nativecounta3.json', 'admin', 'count', 'a3'],
	['front.nativecounta3.json', 'front', 'count', 'a3']
];

const rows = [];
for (const [file, route, arm, rep] of FILES) {
	const r = JSON.parse(readFileSync(join(here, 'raw', file), 'utf8'));
	for (const [label, v] of Object.entries(r.final ?? {})) {
		if (!v || typeof v !== 'object' || !v.sha256Normalized) continue;
		rows.push({
			route: ROUTES[route],
			arm,
			rep,
			label,
			status: v.status,
			sha256Normalized: v.sha256Normalized,
			counts: v.counts ?? null,
			wallMs: v.wallMs,
			cpuMs: v.cpuMs,
			moduleSha256: r.module.sha256,
			moduleBytes: r.module.bytes
		});
	}
}

const q = (c) => ({
	accesses: c.access,
	checks: c.check,
	calls: c.call,
	q: (c.check + c.call) / c.access,
	checksPerAccess: c.check / c.access,
	callsPerAccess: c.call / c.access
});

const plainHash = Object.fromEntries(
	rows
		.filter((x) => x.arm === 'plain')
		.map((x) => [`${x.route}/${x.label}`, x.sha256Normalized])
);
const counted = rows.filter((x) => x.arm === 'count');
const hashMatch = counted.every((x) => x.sha256Normalized === plainHash[`${x.route}/${x.label}`]);

const perRep = counted.map((x) => ({ route: x.route, label: x.label, rep: x.rep, ...q(x.counts) }));
const summary = {
	hashMatchesPlainArm: hashMatch,
	plainNormalizedSha256: plainHash,
	perRep,
	static: JSON.parse(readFileSync(join(here, 'access-bases-tuned.txt'), 'utf8').split('\n')[0])
};
const staticQ = (summary.static.bases + summary.static.calls) / summary.static.accesses;
summary.staticQ = staticQ;

const out = join(here, 'results-draft');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'raw-rows.json'), JSON.stringify(rows, null, 1) + '\n');
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify(summary, null, 1));
