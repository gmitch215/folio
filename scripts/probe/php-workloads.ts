import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { openOldBuild } from './old-build.ts';

// usage: [FOLIO_OLD_BUILD=1] node scripts/probe/php-workloads.ts OUTPUT.jsonl [PAIRS] [WORKERS,...] [PREPARED.bin] [NAME,...]
// FOLIO_CONSUMER names a drupflare worker checkout with a restored .interp
// FOLIO_OLD_BUILD=1 adds an old-N arm per width from the archived pre-admission build and its own plan
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const [output, pairsArg, workersArg, planArg, namesArg] = process.argv.slice(2);
if (!output)
	throw new Error('usage: php-workloads.ts OUTPUT.jsonl [PAIRS] [WORKERS] [PLAN] [NAMES]');
const pairs = Number(pairsArg ?? 20);
const widths = (workersArg ?? '1,2,4,8').split(',').map(Number);
const planPath = planArg ?? new URL('../../build/php-prepared-admit.bin', import.meta.url).pathname;
const oldPlanPath = new URL('../../build/php-prepared.bin', import.meta.url).pathname;
const oldBuild = process.env.FOLIO_OLD_BUILD === '1' ? await openOldBuild() : undefined;
const warmup = 2;

const lcg =
	'$x=12345;if(!function_exists("nx")){function nx(){global $x;$x=($x*1103515245+12345)&0x7fffffff;return $x;}}';
const workloads: Record<string, string> = {
	'sha256-batch':
		'$a=[];for($i=0;$i<3000;$i++){$a[]=hash("sha256",str_repeat(chr(65+$i%26),8192).$i);}echo hash("sha256",implode($a));',
	'md5-crc32-batch':
		'$a=[];for($i=0;$i<6000;$i++){$s=str_repeat(chr(65+$i%26),8192).$i;$a[]=md5($s).crc32($s);}echo md5(implode($a));',
	'bcrypt-batch':
		'$a=[];for($i=0;$i<12;$i++){$a[]=crypt("pw".$i,\'$2y$08$abcdefghijklmnopqrstuu\');}echo md5(implode($a));',
	'pbkdf2-1024': 'echo bin2hex(hash_pbkdf2("sha256","password","salt",40000,64,true));',
	'serialize-roundtrip':
		lcg +
		'$d=[];for($i=0;$i<20000;$i++){$d[]=["id"=>$i,"n"=>nx(),"s"=>str_repeat("k",$i%17),"t"=>[$i,$i*2]];}$s=serialize($d);$u=unserialize($s);$j=json_encode($u);echo md5($s).md5($j).count(json_decode($j,true));',
	'sort-usort':
		lcg +
		'$v=[];for($i=0;$i<30000;$i++)$v[]=nx()%100000;$w=$v;usort($w,fn($a,$b)=>$a<=>$b);sort($v);echo md5(implode(",",$v)).md5(implode(",",$w));',
	'string-ops':
		'$s=str_repeat("The quick brown fox jumps over the lazy dog 0123456789 ",70000);$b=base64_encode($s);echo md5(base64_decode($b)).md5(bin2hex(substr($s,0,1000000))).md5(strrev($s)).md5(str_replace("fox","cat",$s)).md5(strtr($s,"abc","xyz")).md5(ucwords($s));',
	'preg-text':
		lcg +
		'$t="";for($i=0;$i<40000;$i++)$t.="word".(nx()%1000)." ";preg_match_all("/word(\\d+)\\s/",$t,$m);$r=preg_replace_callback("/word(\\d)(\\d*)/",fn($q)=>$q[2].$q[1],$t);echo count($m[1]).md5($r);',
	'array-functions':
		'$a=range(1,300000);$b=array_map(fn($v)=>$v*3+1,$a);$c=array_filter($b,fn($v)=>$v%7==0);echo array_sum($c).md5(implode(",",array_slice(array_reverse($c),0,5000)));',
	'levenshtein-batch':
		lcg +
		'$t=0;for($i=0;$i<400;$i++){$p="";$q="";for($j=0;$j<200;$j++){$p.=chr(97+nx()%26);$q.=chr(97+nx()%26);}$t+=levenshtein($p,$q)+similar_text($p,$q);}echo $t;'
};
const selected = namesArg ? namesArg.split(',') : Object.keys(workloads);

const { default: Factory } = await import(
	pathToFileURL(join(consumer, '.interp/php8.5-worker.tuned.mjs')).href
);
const { PhpBase } = await import(
	pathToFileURL(join(consumer, 'node_modules/php-wasm/PhpBase.mjs')).href
);
const original = readFileSync(join(consumer, '.interp/php8.5.tuned.wasm'));
const nativeModule = new WebAssembly.Module(original);
const g = globalThis as any;
g.self ??= g;
g.location ??= new URL('https://folio.invalid/worker.mjs');
const needPlan = widths.some((width) => width > 1);
const cached = (path: string, make: () => unknown) => {
	if (existsSync(path)) return deserialize(readFileSync(path));
	const prepared = make();
	writeFileSync(path, serialize(prepared));
	return prepared as any;
};
const plan = !needPlan ? undefined : cached(planPath, () => prepare(original));
const oldPlan =
	!needPlan || !oldBuild ? undefined : cached(oldPlanPath, () => oldBuild.prepare(original));

interface Arm {
	name: string;
	run(code: string): Promise<{ output: string; report?: any }>;
	close(): Promise<void>;
}

async function openArm(width: number | 'native', build: 'new' | 'old' = 'new'): Promise<Arm> {
	let pool: Folio | undefined;
	const output: string[] = [];
	const php: any = new PhpBase(
		Promise.resolve({ default: Factory }) as any,
		{
			ini: ['opcache.enable=0', 'opcache.enable_cli=0', 'memory_limit=256M'].join('\n'),
			printErr: () => {},
			instantiateWasm(
				imports: WebAssembly.Imports,
				receive: (instance: any, module: any) => void
			) {
				(async () => {
					await Promise.resolve();
					(imports.env as any).memory = new WebAssembly.Memory({
						initial: 1024,
						maximum: 65536
					});
					if (width === 'native' || width === 1) {
						receive(new WebAssembly.Instance(nativeModule, imports), nativeModule);
					} else {
						pool = await (build === 'old' ? oldBuild!.Folio : Folio).open(
							build === 'old' ? oldPlan! : plan!,
							{ imports, workers: width, profile: true }
						);
						receive({ exports: pool.exports }, nativeModule);
					}
				})().catch((error) => {
					console.error(error);
					process.exit(1);
				});
				return {};
			}
		} as any
	);
	php.addEventListener('output', (event: any) => output.push(...[].concat(event.detail ?? [])));
	await php.binary;
	const parallel = typeof width === 'number' && width > 1;
	return {
		name: width === 'native' ? 'native' : `${build === 'old' ? 'old' : 'folio'}-${width}`,
		async run(code) {
			output.length = 0;
			let report;
			if (parallel) {
				const encoded = new TextEncoder().encode('?>' + code + '\0');
				const pointer = Number((pool!.exports.malloc as CallableFunction)(encoded.length));
				try {
					new Uint8Array(pool!.memory.buffer, pointer, encoded.length).set(encoded);
					report = await pool!.run('pib_run', [pointer]);
					php.flush();
				} finally {
					(pool!.exports.free as CallableFunction)(pointer);
				}
			} else await php._run(code);
			return { output: output.join(''), report };
		},
		close: async () => {
			await pool?.close();
		}
	};
}

const arms: Arm[] = [await openArm('native')];
for (const width of widths) {
	if (oldBuild) arms.push(await openArm(width, 'old'));
	arms.push(await openArm(width));
}
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};
emit({
	kind: 'environment',
	node: process.version,
	v8: process.versions.v8,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	php: 'drupflare php8.5.tuned.wasm',
	artifactSha256: createHash('sha256').update(original).digest('hex'),
	arms: arms.map((arm) => arm.name),
	pairs,
	warmup,
	planned: Boolean(plan?.control),
	planReasons: plan?.controlReasons,
	...(oldBuild ? { oldBuildSha256: oldBuild.digest, oldPlanned: Boolean(oldPlan?.control) } : {})
});
try {
	for (const name of selected) {
		const code = '<?php ' + workloads[name]!;
		let expected: string | undefined;
		for (let round = -warmup; round < pairs; round++) {
			for (let turn = 0; turn < arms.length; turn++) {
				const arm = arms[(turn + round + warmup) % arms.length]!;
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				const result = await arm.run(code);
				const wallMs = performance.now() - start;
				const cpu = process.cpuUsage(cpuStart);
				const digest = createHash('sha256').update(result.output).digest('hex');
				expected ??= digest;
				if (digest !== expected)
					throw new Error(`${name} ${arm.name}: output differs from native`);
				if (round < 0) continue;
				const report = result.report;
				emit({
					kind: 'sample',
					name,
					arm: arm.name,
					round,
					wallMs,
					cpuMs: (cpu.user + cpu.system) / 1000,
					outputSha256: digest,
					passed: true,
					dispatched: report
						? {
								workers: report.workers,
								regions: report.regions,
								replayed: report.replayed,
								fallbacks: report.fallbacks,
								mode: report.mode,
								reason: report.reason,
								workerCpuMs:
									report.profile?.workerCpuMs.reduce(
										(a: number, b: number) => a + b,
										0
									) ?? 0
							}
						: undefined,
					load: loadavg()
				});
			}
		}
	}
} finally {
	for (const arm of arms) await arm.close();
}
