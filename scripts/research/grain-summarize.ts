import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2]!, 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l));
const s = rows.filter((r) => r.kind === 'sample');
const med = (v: number[]) => {
	const a = [...v].sort((x, y) => x - y);
	const m = a.length >> 1;
	return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};
const out: Record<string, unknown>[] = [];
for (const width of [8, 1]) {
	const at = (arm: string, f: (r: any) => number) =>
		s
			.filter((r) => r.width === width && r.arm === arm)
			.sort((a, b) => a.round - b.round)
			.map(f);
	const w = (a: string) => at(a, (r) => r.wallMs);
	const pool = w('pool'),
		cr = w('control_reset'),
		ch = w('control_hot');
	const ratioR = pool.map((p, i) => cr[i]! / p),
		ratioH = pool.map((p, i) => ch[i]! / p);
	const ph = (k: string) => med(at('pool', (r) => r.phases[k]));
	out.push({
		width,
		n: pool.length,
		poolMedianMs: +med(pool).toFixed(3),
		controlResetMedianMs: +med(cr).toFixed(3),
		controlHotMedianMs: +med(ch).toFixed(3),
		speedupVsControlReset: +med(ratioR).toFixed(3),
		speedupVsHot: +med(ratioH).toFixed(3),
		minMaxVsReset: [Math.min(...ratioR), Math.max(...ratioR)].map((x) => +x.toFixed(3)),
		poolCpuMs: +med(at('pool', (r) => r.cpuMs)).toFixed(3),
		workerResetMs: +ph('reset').toFixed(3),
		workerComputeMs: +ph('compute').toFixed(3),
		dispatchMs: +ph('dispatch').toFixed(3),
		workerWallMs: +ph('workerWall').toFixed(3),
		loadMax: Math.max(...s.filter((r) => r.width === width).map((r) => r.load[0]))
	});
}
console.log(JSON.stringify(out, null, 1));
