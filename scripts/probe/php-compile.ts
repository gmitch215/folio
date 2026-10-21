import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { openContexts } from './php-contexts.ts';

// usage: node scripts/probe/php-compile.ts OUTPUT.jsonl [ROUNDS] [INCLUDE_ROUNDS]
// measures what the Zend compile costs in one uncached Drupal render under four opcache arms:
//   off        drupflare's shipped default (src/runtime/opcache.ts DEFAULT_OPCACHE_MODE)
//   file-cold  the shipped `file` arm on a cold instance (compile, then write the cache)
//   pack       the shipped `pack` arm: a baked file cache mounted read-only on a fresh instance
//   shm        the `shm` arm, run only to record whether it fits the interpreter memory
// plus a PHP-side timer per include: opcache_compile_file over the files the render includes
// FOLIO_CONSUMER and FOLIO_WORKER_BUNDLE as in php-concurrent.ts
const [output, roundsArg, includeArg] = process.argv.slice(2);
if (!output) throw new Error('usage: php-compile.ts OUTPUT.jsonl [ROUNDS] [INCLUDE_ROUNDS]');
const rounds = Number(roundsArg ?? 10);
const includeRounds = Number(includeArg ?? 5);
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify({ ...row, load: loadavg() }));
	writeFileSync(output, lines.join('\n') + '\n');
};

const common = [
	'opcache.enable=1',
	'opcache.enable_cli=1',
	'opcache.validate_timestamps=0',
	'opcache.max_accelerated_files=20011',
	'opcache.optimization_level=0x7FFEBFFF'
];
const file = [
	...common,
	'opcache.file_cache=/tmp',
	'opcache.file_cache_only=1',
	'opcache.file_cache_consistency_checks=0'
];
const ini = {
	off: ['opcache.enable=0', 'opcache.enable_cli=0'],
	'file-cold': file,
	pack: [...file, 'opcache.file_cache_read_only=1'],
	shm: common
};
type Arm = keyof typeof ini;

const open = (opcache: string[]) =>
	openContexts({ count: 1, kind: 'drupal', mode: 'native', opcache, bundle, consumer });

async function render(arm: Arm, pack?: Record<string, Uint8Array>) {
	const c = await open(ini[arm]);
	try {
		if (pack) await c.importFiles(0, pack);
		await new Promise((r) => setTimeout(r, 300));
		const [run] = await c.render();
		const exported = arm === 'file-cold' ? await c.exportFiles(0, '/tmp') : undefined;
		return { run: run!, exported, boot: c.boots[0]!.boot };
	} finally {
		await c.close();
	}
}

emit({
	kind: 'environment',
	machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	rounds,
	includeRounds,
	arms: Object.keys(ini)
});

// bake the cache once and discard a cold render so the module's lazy Wasm compile is paid
const warm = await render('file-cold');
const bake = warm.exported!;
const bakeFiles = Object.keys(bake).filter((p) => !p.endsWith('/'));
emit({
	kind: 'bake',
	files: bakeFiles.length,
	bytes: bakeFiles.reduce((sum, p) => sum + bake[p]!.length, 0),
	paths: bakeFiles.slice(0, 3).map((p) => p.replace(/[0-9a-f]{32}/g, '<id>'))
});

const arms: Arm[] = ['off', 'file-cold', 'pack'];
let expected: string | undefined;
for (let round = 0; round < rounds; round++) {
	for (let k = 0; k < arms.length; k++) {
		const arm = arms[(k + round) % arms.length]!;
		const { run, boot } = await render(arm, arm === 'pack' ? bake : undefined);
		expected ??= run.sha256;
		if (run.sha256 !== expected) throw new Error(`${arm}: render output differs`);
		emit({
			kind: 'sample',
			arm,
			round,
			renderWallMs: run.endMs - run.startMs,
			renderThreadCpuMs: run.cpuMs,
			sqlMs: run.sqlMs,
			inflateMs: run.inflateMs,
			inflateCalls: run.inflateCalls,
			phpBootMs: boot.phpBootMs,
			drupalBootMs: boot.drupalBootMs,
			sha256: run.sha256
		});
	}
}

// the shm arm may not fit; record what happens
try {
	const { run } = await render('shm');
	emit({
		kind: 'sample',
		arm: 'shm',
		round: 0,
		renderWallMs: run.endMs - run.startMs,
		sha256: run.sha256
	});
} catch (error) {
	emit({ kind: 'shm-refused', error: String((error as Error).message).slice(0, 400) });
}

// per-include timer: the files one render includes, compiled one by one with opcache_compile_file
// opcache_compile_file also persists the script, so this is an upper bound on the Zend compile
const list = `<?php
$before = get_included_files();
$GLOBALS['__before'] = $before;
`;
for (let round = 0; round < includeRounds; round++) {
	const probe = await open(ini.off);
	let files: { path: string; bytes: number }[];
	try {
		await probe.run(0, list);
		await probe.render();
		const raw = await probe.run(
			0,
			`<?php $b=array_flip($GLOBALS['__before']);$o=[];foreach(get_included_files() as $f){if(!isset($b[$f]))$o[]=['path'=>$f,'bytes'=>(int)@filesize($f)];}echo json_encode($o);`,
			true
		);
		files = JSON.parse(raw.output!);
	} finally {
		await probe.close();
	}
	for (const optimizer of ['0x7FFEBFFF', '0']) {
		const c = await open([
			'opcache.enable=1',
			'opcache.enable_cli=1',
			'opcache.validate_timestamps=0',
			'opcache.max_accelerated_files=20011',
			`opcache.optimization_level=${optimizer}`
		]);
		try {
			await new Promise((r) => setTimeout(r, 300));
			const list = JSON.stringify(files.map((f) => f.path));
			const raw = await c.run(
				0,
				`<?php $o=[];foreach(${list} as $f){$t0=hrtime(true);$d=@file_get_contents($f);$t1=hrtime(true);$ok=@opcache_compile_file($f);$t2=hrtime(true);$o[]=[$f,strlen((string)$d),$t1-$t0,$t2-$t1,$ok];}echo json_encode($o);`,
				true
			);
			const rows = JSON.parse(raw.output!) as [string, number, number, number, boolean][];
			emit({
				kind: 'includes',
				round,
				optimizer,
				includes: rows.length,
				compiled: rows.filter((r) => r[4]).length,
				bytes: rows.reduce((s, r) => s + r[1], 0),
				readMs: rows.reduce((s, r) => s + r[2], 0) / 1e6,
				compileMs: rows.reduce((s, r) => s + r[3], 0) / 1e6,
				top: [...rows]
					.sort((a, b) => b[3] - a[3])
					.slice(0, 10)
					.map((r) => ({
						path: r[0].replace(/^.*\/(core|vendor)\//, '$1/'),
						bytes: r[1],
						ms: r[3] / 1e6
					})),
				perInclude: rows.map((r) => ({ bytes: r[1], ms: r[3] / 1e6 }))
			});
		} finally {
			await c.close();
		}
	}
}
