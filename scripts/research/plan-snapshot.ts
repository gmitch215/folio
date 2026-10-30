import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// usage: node plan-snapshot.ts ROOT OUT [extra.wasm ...]
// dumps the stable plan fields of prepare() for every fixture and corpus artifact under ROOT, at
// default admission and at minimumRegionWork 0, with module bytes replaced by their digests
const [root, out, ...extra] = process.argv.slice(2);
if (!root || !out) throw new Error('usage: plan-snapshot.ts ROOT OUT [extra.wasm ...]');
const { prepare } = await import(pathToFileURL(join(root, 'src/compiler.ts')).href);

const wasmIn = (dir: string) =>
	existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.endsWith('.wasm'))
				.sort()
				.map((name) => join(dir, name))
		: [];
const files = [
	...wasmIn(join(root, 'build')),
	...wasmIn(join(root, 'build/research/corpus/artifacts')),
	join(root, 'results/corpus/blake3-consumer/blake3-hash-all.wasm'),
	...extra
];

const digest = (bytes: Uint8Array) =>
	`sha256:${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`;
const stable = (value: unknown): unknown => {
	if (value instanceof Uint8Array) return digest(value);
	if (typeof value === 'bigint') return `${value}n`;
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, item]) => [key, stable(item)])
		);
	return value;
};

const plans: Record<string, unknown> = {};
const routes: Record<string, unknown> = {};
const iterations: Record<string, unknown> = {};
for (const file of files) {
	const bytes = new Uint8Array(readFileSync(file));
	for (const [mode, options] of [
		['default', {}],
		['zero', { minimumRegionWork: 0 }]
	] as const) {
		const key = `${relative(root, file)} ${mode}`;
		const prepared = prepare(bytes, options);
		plans[key] = stable({
			original: prepared.original,
			transactional: prepared.transactional,
			loops: prepared.loops,
			loopReasons: prepared.loopReasons,
			native: prepared.native,
			reasons: prepared.reasons,
			control: prepared.control,
			controlReasons: prepared.controlReasons
		});
		if (prepared.stackRoute) {
			const { work, functions, recursive, ...rest } = prepared.stackRoute;
			routes[key] = stable({
				...rest,
				functions: functions.length,
				recursive,
				work: Object.keys(work).length
			});
		}
		if (prepared.iterationRoute) iterations[key] = stable(prepared.iterationRoute);
	}
}
const text = JSON.stringify(plans, null, '\t');
writeFileSync(out, `${text}\n`);
console.log(
	`${Object.keys(plans).length} plans, sha256 ${createHash('sha256').update(text).digest('hex')}`
);
if (Object.keys(routes).length)
	writeFileSync(`${out}.stack.json`, `${JSON.stringify(routes, null, '\t')}\n`);
if (Object.keys(iterations).length)
	writeFileSync(`${out}.iteration.json`, `${JSON.stringify(iterations, null, '\t')}\n`);
