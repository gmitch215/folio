import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// certified, executable and accelerated function counts from the committed certifier and cost results
// usage: certify-counts.ts [--json]

const root = new URL('../../', import.meta.url).pathname;
const subjectsPath = join(root, 'results/certification/stream-certifier/subjects.json');
const cells = join(root, 'results/execution/certified-cost-widened/cells');

interface Row {
	kind: string;
	name: string;
	verdict: string;
	ring?: string;
	output?: { inPlace: true; step: string };
}

const subjects = (JSON.parse(readFileSync(subjectsPath, 'utf8')) as { rows: Row[] }).rows.filter(
	(r) => r.kind === 'real'
);

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// median over sessions of each session's serial median over its steady median
function speedup(name: string): number | undefined {
	const ratios: number[] = [];
	for (const session of [1, 2, 3])
		for (const mib of [8, 64]) {
			const path = join(cells, `s${session}-m${mib}-${name}.json`);
			if (!existsSync(path)) continue;
			const cell = JSON.parse(readFileSync(path, 'utf8')) as {
				steadyMs: number[];
				serialMs: number[];
			};
			ratios.push(median(cell.serialMs) / median(cell.steadyMs));
		}
	return ratios.length ? median(ratios) : undefined;
}

const sets: Record<string, string[]> = {
	'affine folds': ['crc32c', 'crc16', 'crc64', 'poly31', 'lcg', 'miniz-crc32', 'adler32'],
	'in-place kernels': ['xlcg', 'xshift', 'xsbox', 'xfeed'],
	'all real subjects': subjects.map((r) => r.name)
};

const out: Record<string, object> = {};
for (const [label, names] of Object.entries(sets)) {
	const rows = names.map((n) => subjects.find((r) => r.name === n)).filter((r): r is Row => !!r);
	const certified = rows.filter((r) => r.verdict === 'certified');
	const executable = certified.filter((r) => !r.output || r.output.step !== 'reads the bytes');
	const accelerated = executable.filter((r) => (speedup(r.name) ?? 0) > 1);
	out[label] = {
		subjects: rows.length,
		certified: certified.length,
		executable: executable.length,
		accelerated: accelerated.length,
		certifiedNotExecutable: certified.filter((r) => !executable.includes(r)).map((r) => r.name),
		executableNotAccelerated: executable
			.filter((r) => !accelerated.includes(r))
			.map((r) => r.name)
	};
}

if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
	console.log('set | subjects | certified | executable | accelerated');
	for (const [label, v] of Object.entries(out) as [string, Record<string, unknown>][])
		console.log(
			`${label} | ${v.subjects} | ${v.certified} | ${v.executable} | ${v.accelerated}`
		);
	for (const [label, v] of Object.entries(out) as [string, Record<string, unknown>][]) {
		const gaps = [
			...(v.certifiedNotExecutable as string[]),
			...(v.executableNotAccelerated as string[])
		];
		if (gaps.length)
			console.log(`${label}: not executable or not accelerated: ${gaps.join(', ')}`);
	}
}
