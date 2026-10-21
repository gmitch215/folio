import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { openContexts } from './php-contexts.ts';
import { defaultSizes, prelude, requestCode, workloads } from './php-tasks.ts';
import { census, children } from './purity-census.ts';

// usage: node scripts/probe/indirect-sites.ts OUTPUT.jsonl [DRUPAL_RENDERS] [MODULE.wasm]
// instruments every call_indirect in the PHP artifact (the target operand goes through an imported
// hook that counts site and target and returns the target unchanged), runs an uncached Drupal
// render and the 8-job hash batch on it, and writes per-site target counts plus the purity
// census label of every dynamic target. Counting only; nothing here is a parallel mechanism.
const [output, rendersArg, moduleArg] = process.argv.slice(2);
if (!output) throw new Error('usage: indirect-sites.ts OUTPUT.jsonl [RENDERS] [MODULE.wasm]');
const renders = Number(rendersArg ?? 3);
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const original = readFileSync(moduleArg ?? resolve(consumer, '.interp/php8.5.tuned.wasm'));
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};

export function instrument(bytes: Uint8Array) {
	const m = binaryen.readBinary(bytes);
	m.addFunctionImport(
		'folio_ci',
		'folio',
		'ci',
		binaryen.createType([binaryen.i32, binaryen.i32]),
		binaryen.i32
	);
	const sites: { site: number; fn: string }[] = [];
	let unreadable = 0;
	for (let i = 0; i < m.getNumFunctions(); i++) {
		const info = binaryen.getFunctionInfo(m.getFunctionByIndex(i));
		if (!info.body) continue;
		const visit = (e: number) => {
			const id = binaryen.getExpressionId(e);
			if (id === binaryen.NopId || id === binaryen.UnreachableId) return;
			const v: any = binaryen.getExpressionInfo(e);
			for (const child of children(v)) visit(child);
			if (v.id === binaryen.CallIndirectId) {
				const site = sites.length;
				sites.push({ site, fn: info.name });
				(binaryen as any)._BinaryenCallIndirectSetTarget(
					e,
					m.call('folio_ci', [m.i32.const(site), v.target], binaryen.i32)
				);
			}
		};
		try {
			visit(info.body);
		} catch {
			unreadable++;
		}
	}
	const out = new Uint8Array(m.emitBinary());
	m.dispose();
	if (!WebAssembly.validate(out)) throw new Error('instrumented module does not validate');
	return { bytes: out, sites, unreadable };
}

const t0 = performance.now();
const { bytes, sites, unreadable } = instrument(original);
const names = binaryen.readBinary(bytes);
const nameOf = (index: number) => binaryen.getFunctionInfo(names.getFunctionByIndex(index)).name;
const base = census(original);
emit({
	kind: 'environment',
	machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	sites: sites.length,
	unreadableFunctions: unreadable,
	instrumentMs: performance.now() - t0,
	instrumentedBytes: bytes.length,
	originalBytes: original.length,
	labels: base.labels,
	definedFunctions: base.definedFunctions
});
const module = new WebAssembly.Module(bytes);

async function measure(
	kind: 'plain' | 'drupal',
	label: string,
	runs: (c: any) => Promise<string[]>
) {
	const c = await openContexts({
		count: 1,
		kind,
		mode: 'native',
		module,
		instrument: true,
		bundle,
		consumer
	});
	try {
		await c.indirectCounts(0);
		const sha256 = await runs(c);
		const { triples, targets } = await c.indirectCounts(0);
		const functions: Record<number, { name: string; label: string }> = {};
		for (const [t, index] of Object.entries(targets)) {
			const name = nameOf(Number(index));
			functions[Number(t)] = {
				name,
				label: base.labels[base.functionLabels[name] ?? -1] ?? 'unknown'
			};
		}
		const seen = new Set<number>();
		for (let i = 0; i < triples.length; i += 3) seen.add(triples[i]!);
		const siteFn = Object.fromEntries(
			[...seen].map((s) => {
				const fn = sites[s]!.fn;
				return [s, { fn, label: base.labels[base.functionLabels[fn] ?? -1] ?? 'unknown' }];
			})
		);
		emit({ kind: 'counts', label, sha256, triples, functions, siteFn, load: loadavg() });
	} finally {
		await c.close();
	}
}

await measure('drupal', 'drupal-render', async (c) => {
	const shas: string[] = [];
	for (let i = 0; i < renders; i++) shas.push((await c.render())[0].sha256);
	return shas;
});
const hash = workloads.find((w) => w.name === 'hash-batch')!;
await measure('plain', 'hash-batch-request', async (c) => {
	await c.run(0, prelude);
	return [(await c.run(0, requestCode(hash, defaultSizes['hash-batch']!, 'plain'))).sha256];
});
