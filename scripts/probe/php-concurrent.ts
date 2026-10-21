import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { type Contexts, loadPlan, openContexts, overlapMs } from './php-contexts.ts';

// usage: node scripts/probe/php-concurrent.ts cpu|drupal OUTPUT.jsonl [PAIRS] [WIDTHS] [WORKLOADS]
//        node scripts/probe/php-concurrent.ts memory OUTPUT.jsonl cpu|drupal native|folio COUNT
// four arms per width: native-serial, native-concurrent, folio-serial, folio-concurrent
// FOLIO_CONSUMER names a drupflare worker checkout; FOLIO_WORKER_BUNDLE a prebuilt worker bundle;
// FOLIO_PLAN the prepared admit plan; FOLIO_MACHINE labels the machine in the environment row
const [kind, output, ...rest] = process.argv.slice(2);
if (!kind || !output)
	throw new Error('usage: php-concurrent.ts cpu|drupal|memory OUTPUT.jsonl ...');
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const planPath =
	process.env.FOLIO_PLAN ??
	new URL('../../build/php-prepared-admit.bin', import.meta.url).pathname;
const plan = existsSync(planPath) ? loadPlan(planPath) : undefined;
const now = () => performance.timeOrigin + performance.now();
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};

const lcg =
	'$x=12345;if(!function_exists("nx")){function nx(){global $x;$x=($x*1103515245+12345)&0x7fffffff;return $x;}}';
// read-only CPU endpoints: same input every request, the response is a digest
const endpoints: Record<string, string> = {
	'sha256-batch':
		'$a=[];for($i=0;$i<3000;$i++){$a[]=hash("sha256",str_repeat(chr(65+$i%26),8192).$i);}echo hash("sha256",implode($a));',
	'serialize-roundtrip':
		lcg +
		'$d=[];for($i=0;$i<20000;$i++){$d[]=["id"=>$i,"n"=>nx(),"s"=>str_repeat("k",$i%17),"t"=>[$i,$i*2]];}$s=serialize($d);$u=unserialize($s);$j=json_encode($u);echo md5($s).md5($j).count(json_decode($j,true));',
	'preg-text':
		lcg +
		'$t="";for($i=0;$i<40000;$i++)$t.="word".(nx()%1000)." ";preg_match_all("/word(\\d+)\\s/",$t,$m);$r=preg_replace_callback("/word(\\d)(\\d*)/",fn($q)=>$q[2].$q[1],$t);echo count($m[1]).md5($r);'
};

const arms = ['native-serial', 'native-concurrent', 'folio-serial', 'folio-concurrent'] as const;
type Arm = (typeof arms)[number];

async function cell(
	arm: Arm,
	width: number,
	contexts: Contexts,
	run: (indices: number[], serial: boolean) => Promise<any[]>
) {
	const serial = arm.endsWith('serial');
	const dispatch = now();
	const cpu0 = process.cpuUsage();
	const wall0 = performance.now();
	const runs: any[] = [];
	if (serial) {
		for (let i = 0; i < width; i++) runs.push(...(await run([i], true)));
	} else
		runs.push(
			...(await run(
				Array.from({ length: width }, (_, i) => i),
				false
			))
		);
	const wallMs = performance.now() - wall0;
	const cpu = process.cpuUsage(cpu0);
	return {
		arm,
		width,
		wallMs,
		throughput: (width / wallMs) * 1000,
		processCpuMs: (cpu.user + cpu.system) / 1000,
		threadCpuMs: runs.map((r) => r.cpuMs),
		latencyMs: runs.map((r) => r.endMs - (serial ? r.startMs : dispatch)),
		serviceMs: runs.map((r) => r.endMs - r.startMs),
		startSkewMs:
			Math.max(...runs.map((r) => r.startMs)) - Math.min(...runs.map((r) => r.startMs)),
		overlapMs: overlapMs(runs),
		sha256: runs.map((r) => r.sha256),
		rssBytes: process.memoryUsage().rss,
		load: loadavg(),
		runs: kind === 'drupal' ? runs : undefined
	};
}

function environment(extra: object) {
	emit({
		kind: 'environment',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		affinity: process.env.FOLIO_AFFINITY,
		artifactSha256: sha(
			readFileSync(join(consumer, '.interp/php8.5.tuned.wasm')).toString('latin1')
		),
		plan: { control: Boolean(plan?.control), reasons: plan?.controlReasons },
		...extra
	});
}

if (kind === 'cpu') {
	const pairs = Number(rest[0] ?? 20);
	const widths = (rest[1] ?? '1,2,4,8').split(',').map(Number);
	const names = rest[2] ? rest[2].split(',') : Object.keys(endpoints);
	const top = Math.max(...widths);
	const open = (mode: 'native' | 'folio') =>
		openContexts({ count: top, kind: 'plain', mode, plan, bundle, consumer });
	const contexts = { native: await open('native'), folio: await open('folio') };
	environment({
		experiment: 'A-cpu',
		pairs,
		widths,
		arms,
		boots: { native: contexts.native.boots, folio: contexts.folio.boots }
	});
	const cells = widths.flatMap((width) => arms.map((arm) => ({ arm, width })));
	for (const name of names) {
		const code = '<?php ' + endpoints[name]!;
		let expected: string | undefined;
		for (const c of [contexts.native, contexts.folio]) {
			const warm = await c.runAll(code, undefined, true);
			for (const r of warm) {
				expected ??= r.sha256;
				if (r.sha256 !== expected) throw new Error(`${name}: warmup output differs`);
			}
		}
		for (let round = -1; round < pairs; round++) {
			for (let turn = 0; turn < cells.length; turn++) {
				const { arm, width } = cells[(turn + round + 1) % cells.length]!;
				const c = contexts[arm.startsWith('native') ? 'native' : 'folio'];
				const row = await cell(arm, width, c, (indices, serial) =>
					serial ? c.runAll(code, [0]) : c.runAll(code, indices)
				);
				if (row.sha256.some((s) => s !== expected))
					throw new Error(`${name} ${arm}: output differs`);
				if (round >= 0) emit({ kind: 'sample', experiment: 'A-cpu', name, round, ...row });
			}
		}
	}
	await Promise.all([contexts.native.close(), contexts.folio.close()]);
} else if (kind === 'drupal') {
	const pairs = Number(rest[0] ?? 10);
	const widths = (rest[1] ?? '1,2,4,8').split(',').map(Number);
	environment({ experiment: 'A-drupal', pairs, widths, arms });
	const cells = widths.flatMap((width) => arms.map((arm) => ({ arm, width })));
	let expected: string | undefined;
	for (let round = -1; round < pairs; round++) {
		for (let turn = 0; turn < cells.length; turn++) {
			const { arm, width } = cells[(turn + round + 1) % cells.length]!;
			const mode = arm.startsWith('native') ? 'native' : 'folio';
			const rss0 = process.memoryUsage().rss;
			const t0 = performance.now();
			const c = await openContexts({
				count: width,
				kind: 'drupal',
				mode,
				plan,
				bundle,
				consumer
			});
			const openMs = performance.now() - t0;
			await new Promise((r) => setTimeout(r, 300));
			const row = await cell(arm, width, c, (indices, serial) =>
				serial ? c.render([indices[0]!]) : c.render(indices)
			);
			for (const s of row.sha256) {
				expected ??= s;
				if (s !== expected) throw new Error(`${arm}: Drupal render differs`);
			}
			if (round >= 0)
				emit({
					kind: 'sample',
					experiment: 'A-drupal',
					name: 'drupal-uncached-render',
					round,
					openMs,
					openRssDeltaBytes: row.rssBytes - rss0,
					boots: c.boots.map((b) => b.boot),
					...row
				});
			await c.close();
		}
	}
} else if (kind === 'memory') {
	const [what, mode, countArg] = rest as ['cpu' | 'drupal', 'native' | 'folio', string];
	const count = Number(countArg);
	const rss0 = process.memoryUsage().rss;
	const c = await openContexts({
		count,
		kind: what === 'cpu' ? 'plain' : 'drupal',
		mode,
		plan,
		bundle,
		consumer
	});
	const opened = process.memoryUsage().rss;
	const code = what === 'cpu' ? '<?php ' + endpoints['sha256-batch']! : '';
	const runs = what === 'cpu' ? await c.runAll(code) : await c.render();
	const after = process.memoryUsage().rss;
	emit({
		kind: 'memory',
		what,
		mode,
		count,
		rssBeforeBytes: rss0,
		rssOpenedBytes: opened,
		rssAfterRunBytes: after,
		maxRssBytes: process.resourceUsage().maxRSS * 1024,
		wasmMemoryBytes: runs.map((r) => r.memoryBytes),
		perContextOpenBytes: (opened - rss0) / count,
		perContextAfterRunBytes: (after - rss0) / count
	});
	await c.close();
} else throw new Error('unknown kind ' + kind);
