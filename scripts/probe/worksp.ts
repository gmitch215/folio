import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { openContexts } from './php-contexts.ts';
import { defaultSizes, drupalPrelude, prelude, requestCode, workloads } from './php-tasks.ts';
import type { HookConfig } from './worksp-hooks.ts';
import { instrumentWorksp, phpExtents, type Mode } from './worksp-instrument.ts';

// work-span profile of one PHP request at the userland call granularity
// usage: node scripts/probe/worksp.ts OUTPUT.jsonl MODE INPUTS [REPEATS] [RC_SITES.json]
//   MODE count (counters only) or trace (full trace and ladder), INPUTS a comma list of
//   drupal-render, hash-chains, dependent-chain, serialize-json, twig-render, calls
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE as in php-concurrent.ts;
// FOLIO_WORKSP_EXPOSURE=0 and FOLIO_WORKSP_DEADSTACK=0 switch a recorder rule off for a comparison,
// FOLIO_WORKSP_FINE=all|label,label makes those invocations opcode-grained, FOLIO_WORKSP_PRIV a JSON
// object of input name (or default) to private-state rungs [{name, labels?, all?}],
// FOLIO_WORKSP_SENS=0 skips the sensitivity table, FOLIO_WORKSP_STACKLOG=1 groups stack RAW edges;
// FOLIO_WORKSP_SIZES overrides request sizes as JSON, FOLIO_WORKSP_HEAP_MB the worker heap
const [output, modeArg, inputsArg, repeatsArg, rcFile] = process.argv.slice(2);
if (!output || !modeArg || !inputsArg)
	throw new Error('usage: worksp.ts OUTPUT.jsonl count|trace INPUTS [REPEATS] [RC_SITES.json]');
const mode = modeArg as Mode;
const repeats = Number(repeatsArg ?? 1);
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const original = readFileSync(resolve(consumer, '.interp/php8.5.tuned.wasm'));
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};

const extents = phpExtents(original);
const { stackHigh } = extents;
const sizes: Record<string, any> = {
	...defaultSizes,
	'hash-chains': { n: 300 },
	'dependent-chain': { n: 2000 },
	'serialize-json': { n: 1500 },
	'twig-render': { n: 40 },
	'shared-var': { n: 300 },
	...JSON.parse(process.env.FOLIO_WORKSP_SIZES ?? '{}')
};
const STACK_BYTES = 32 * 1024 * 1024;
const stackLow = stackHigh - STACK_BYTES;
const layout = {
	stack: [stackLow, stackHigh] as [number, number],
	static: [1024, stackLow] as [number, number]
};
const rcSites: number[] | undefined = rcFile
	? JSON.parse(readFileSync(rcFile, 'utf8')).sites
	: undefined;

const t0 = performance.now();
const noExtent = process.env.FOLIO_WORKSP_NOEXTENT === '1';
const instrumented = instrumentWorksp(original, {
	mode,
	dispatch: noExtent ? 'none' : extents.dispatch,
	alloc: noExtent ? [] : extents.alloc,
	out: noExtent ? [] : extents.out,
	allCounters: process.env.FOLIO_WORKSP_ALLCOUNTERS === '1',
	range: process.env.FOLIO_WORKSP_RANGE
		? (process.env.FOLIO_WORKSP_RANGE.split(',').map(Number) as [number, number])
		: undefined
});
const moduleSha = createHash('sha256').update(original).digest('hex');
emit({
	kind: 'environment',
	experiment: 'worksp',
	mode,
	machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	module: { name: 'php8.5.tuned.wasm', sha256: moduleSha, bytes: original.length },
	instrumentedBytes: instrumented.bytes.length,
	instrumentMs: performance.now() - t0,
	instrument: instrumented.stats,
	sites: instrumented.sites.offset.length,
	allocFunctions: extents.alloc.length,
	outputFunctions: extents.out.length,
	layout,
	stackBytes: stackHigh - stackLow,
	rcSitesVerified: rcSites?.length
});
const instrumentedModule = new WebAssembly.Module(instrumented.bytes);
const originalModule = new WebAssembly.Module(original);

const inputs: Record<string, { kind: 'plain' | 'drupal'; code?: string; render?: boolean }> = {
	'drupal-render': { kind: 'drupal', render: true },
	'hash-chains': {
		kind: 'plain',
		code: requestCode(
			workloads.find((w) => w.name === 'hash-batch')!,
			sizes['hash-chains'],
			'plain'
		)
	},
	'dependent-chain': {
		kind: 'plain',
		code: `<?php function f($x){return hash('sha256',str_repeat($x,64));}$x='seed';for($i=0;$i<${sizes['dependent-chain'].n};$i++){$x=f($x);}echo $x;`
	},
	'serialize-json': {
		kind: 'plain',
		code: requestCode(
			workloads.find((w) => w.name === 'serialize-roundtrip')!,
			sizes['serialize-json'],
			'plain'
		)
	},
	'twig-render': {
		kind: 'drupal',
		code: requestCode(
			workloads.find((w) => w.name === 'drupal-render-arrays')!,
			sizes['twig-render'],
			'plain'
		)
	},
	'shared-var': {
		kind: 'plain',
		code: `<?php function g($i){global $cnt;$cnt=($cnt??0)+$i+1;$h=(string)$cnt;for($j=0;$j<${sizes['shared-var'].n};$j++){$h=hash('sha256',str_repeat($h,64));}return $h;}$out=[];for($i=0;$i<8;$i++){$out[]=g($i);}echo md5(serialize($out));`
	},
	calls: {
		kind: 'plain',
		code: '<?php function g($a){return $a+1;}class K{function m($a){return $a+2;}static function s($a){return $a+3;}}$k=new K;$t=0;for($i=0;$i<100;$i++){$t+=g($i);}for($i=0;$i<50;$i++){$t+=$k->m($i);}for($i=0;$i<25;$i++){$t+=K::s($i);}$t+=array_sum(array_map(fn($v)=>$v*2,range(1,10)));echo $t;'
	}
};

const off = (name: string) => process.env[name] === '0';
const fineEnv = process.env.FOLIO_WORKSP_FINE;
const privEnv = process.env.FOLIO_WORKSP_PRIV ? JSON.parse(process.env.FOLIO_WORKSP_PRIV) : {};
const hookConfig = (verify: boolean, name: string): HookConfig => ({
	mode,
	sites: mode === 'trace' ? instrumented.sites : undefined,
	layout,
	rcSites,
	verify,
	exposure: !off('FOLIO_WORKSP_EXPOSURE'),
	deadStack: !off('FOLIO_WORKSP_DEADSTACK'),
	stackLog: process.env.FOLIO_WORKSP_STACKLOG === '1',
	watch: process.env.FOLIO_WORKSP_WATCH?.split(',').map(Number),
	fine: fineEnv === 'all' ? 'all' : fineEnv ? fineEnv.split(',') : undefined,
	analysis: {
		sensitivity: !off('FOLIO_WORKSP_SENS'),
		priv: privEnv[name] ?? privEnv.default,
		siblings: { minShare: Number(process.env.FOLIO_WORKSP_MINSHARE ?? 0.01) }
	},
	meta: {
		module: { name: 'php8.5.tuned.wasm', sha256: moduleSha },
		machine: { name: process.env.FOLIO_MACHINE ?? 'unlabeled', node: process.version }
	}
});

async function nativeMs(kind: 'plain' | 'drupal', input: (typeof inputs)[string]) {
	// the first render in a context is the uncached one; a throwaway context warms V8 first
	if (input.render) await nativeOnce(kind, input);
	return nativeOnce(kind, input);
}

async function nativeOnce(kind: 'plain' | 'drupal', input: (typeof inputs)[string]) {
	const c = await openContexts({
		count: 1,
		kind,
		mode: 'native',
		module: originalModule,
		bundle,
		consumer
	});
	try {
		if (kind === 'drupal') {
			if (input.code) {
				await c.render();
				await c.run(0, prelude);
				await c.run(0, drupalPrelude);
			}
		} else await c.run(0, prelude);
		const run = input.render ? (await c.render())[0]! : await c.run(0, input.code!);
		return { ms: run.endMs - run.startMs, sha256: run.sha256 };
	} finally {
		await c.close();
	}
}

for (const name of inputsArg.split(',')) {
	const input = inputs[name];
	if (!input) throw new Error(`unknown input ${name}`);
	const native = await nativeMs(input.kind, input);
	for (let repeat = 0; repeat < repeats; repeat++) {
		const c = await openContexts({
			count: 1,
			kind: input.kind,
			mode: 'native',
			module: instrumentedModule,
			worksp: hookConfig(false, name),
			heapMb: Number(process.env.FOLIO_WORKSP_HEAP_MB ?? 12000),
			bundle,
			consumer
		});
		try {
			if (input.kind === 'drupal' && input.code) {
				await c.render();
				await c.run(0, prelude);
				await c.run(0, drupalPrelude);
			} else if (input.kind === 'plain') await c.run(0, prelude);
			const t1 = performance.now();
			const run = await c.worksp(0, {
				render: input.render,
				code: input.code,
				input: { id: name, sha256: native.sha256 }
			});
			emit({
				kind: 'sample',
				mode,
				name,
				repeat,
				requestWallMs: performance.now() - t1,
				nativeMs: native.ms,
				slowdown: run.traced.wallMs / native.ms,
				outputSha256: run.sha256,
				nativeSha256: native.sha256,
				outputEqual: run.sha256 === native.sha256,
				counters: run.counters,
				counts: run.traced.counts,
				stats: run.traced.stats,
				graph: run.traced.graph,
				watch: run.traced.watch,
				analyzeMs: run.traced.analyzeMs,
				finishMs: run.traced.finishMs,
				instrumentedWallMs: run.traced.wallMs,
				load: loadavg(),
				...(run.traced.record ? { record: { ...run.traced.record, repeat } } : {})
			});
		} finally {
			await c.close();
		}
	}
}
