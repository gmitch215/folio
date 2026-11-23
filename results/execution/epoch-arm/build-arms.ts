import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { translate } from './elastic-translate.ts';

// usage: node build-arms.ts --from=<module.wasm> --out=<dir> arm ...
// writes <dir>/<arm>.wasm and <dir>/<arm>.json. r-heap32 is one arena over the static data, the
// stack window and the first 32 MiB of heap; ep-heap32 is the same arena with epoch groups.
// The -count arms add the dynamic counters.
const argValue = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const source = argValue('from');
const out = argValue('out');
if (!source || !out) throw new Error('usage: build-arms.ts --from=<module.wasm> --out=<dir> arm ...');
const bytes = readFileSync(source);
const STACK_BASE = 37970912;
const STACK_END = STACK_BASE - 33554432;
const tableBase = Math.ceil(STACK_END / 65536) * 65536;
const common = {
	shape: 'inline' as const,
	exempt: true,
	hoist: true,
	tableBase,
	staticLimit: STACK_END,
	stackFloor: STACK_BASE - (1 << 20)
};
const MiB = 1 << 20;
const heap32 = { arenas: [{ lo: 65536, size: STACK_BASE - 65536 + 32 * MiB }] };
const arms: Record<string, any> = {
	'r-heap32': heap32,
	'r-heap32-count': { ...heap32, count: true },
	'ep-heap32': { ...heap32, epoch: true },
	'ep-heap32-count': { ...heap32, epoch: true, count: true }
};
mkdirSync(out, { recursive: true });
for (const name of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
	if (!arms[name]) throw new Error(`unknown arm ${name}`);
	const t0 = performance.now();
	const r = translate(bytes, { ...common, ...arms[name] });
	writeFileSync(`${out}/${name}.wasm`, r.bytes);
	writeFileSync(
		`${out}/${name}.json`,
		JSON.stringify(
			{ name, options: { ...common, ...arms[name] }, tableBase, ms: Math.round(performance.now() - t0), bytes: r.bytes.length, stats: r.stats },
			null,
			1
		)
	);
	console.log(name, r.bytes.length, JSON.stringify(r.stats));
}
