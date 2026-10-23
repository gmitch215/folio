import { PHP_CODEC } from 'consumer:host/codec';
import { mkdirp, mountDriver, mountDrupalLazy } from 'consumer:host/fs';
import { withMask } from 'consumer:host/mask';
import { SiteDurableObject } from 'consumer:host/site-store';
import 'consumer:host/worker-shim';
import { PhpBase } from 'consumer:node_modules/php-wasm/PhpBase.mjs';
import { decodeParam } from 'consumer:src/db/migrate-sql.ts';
import { INTERPRETER_MEMORY } from 'consumer:src/do/isolate.ts';
import { SERVICES_YAML, settingsOverride } from 'consumer:src/do/settings.ts';
import { ARGON2_FIX } from 'consumer:src/drupal/argon2-fix.ts';
import { CURL_FIX } from 'consumer:src/drupal/curl-fix.ts';
import { ICONV_FIX } from 'consumer:src/drupal/iconv-fix.ts';
import { MB_FIX } from 'consumer:src/drupal/mb-fix.ts';
import { OPENSSL_FIX } from 'consumer:src/drupal/openssl-fix.ts';
import { BOOT_KERNEL, renderPage } from 'consumer:src/drupal/site-php.ts';
import { SODIUM_FIX } from 'consumer:src/drupal/sodium-fix.ts';
import { DISABLED, STANDIN_FIX } from 'consumer:src/drupal/standin-fix.ts';
import { XMLWRITER_FIX } from 'consumer:src/drupal/xmlwriter-fix.ts';
import { installZlib, ZLIB_FIX } from 'consumer:src/drupal/zlib-fix.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import type { Folio as FolioPool } from '../../src/node.ts';

// bundled and run by scripts/probe/php-render.ts: node scripts/probe/php-render.ts native|folio [OUTPUT.json] [PREPARED.bin]
// FOLIO_WORKERS sets the folio pool width, two by default; FOLIO_SRC_DIR points at another src/ tree
const consumer = resolve(process.env.FOLIO_CONSUMER ?? '');
const mode = process.argv[2] ?? 'native';
if (mode !== 'native' && mode !== 'folio') throw new Error('mode must be native or folio');
const build = new URL('.', import.meta.url).pathname;
mkdirSync(build, { recursive: true });
const outPath = process.argv[3] ?? join(build, 'php-render-' + mode + '.json');
const planPath = process.argv[4] ?? join(build, 'php-prepared.bin');
// the library loads at run time, so the bundle never carries a second copy of it
const source = process.env.FOLIO_SRC_DIR ?? new URL('../src/', import.meta.url).href;
const { Folio } = await import(new URL('node.ts', source).href);
const { prepare } = await import(new URL('compiler.ts', source).href);

const result: any = { mode, node: process.version, stages: [], reports: [] };
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const started = performance.now();
function stage(name: string, data: object = {}) {
	const cpu = process.cpuUsage();
	const value = {
		name,
		wallMs: performance.now() - started,
		cpuMs: (cpu.user + cpu.system) / 1000,
		...data
	};
	result.stages.push(value);
	writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
	console.log(JSON.stringify(value));
}

const db = new DatabaseSync(':memory:');
const sqlTrace: string[] = [];
const sql = {
	exec(text: string, ...params: any[]) {
		sqlTrace.push(text);
		const statement = db.prepare(text);
		const changes = () => db.prepare('SELECT total_changes() AS n').get()!.n as number;
		const before = changes();
		const rows = statement.all(
			...params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))
		);
		return { toArray: () => rows, rowsRead: rows.length, rowsWritten: changes() - before };
	}
};
const bridge = new SiteDurableObject(
	{
		storage: {
			sql,
			transactionSync(fn: () => unknown) {
				db.exec('SAVEPOINT folio_request');
				try {
					const value = fn();
					db.exec('RELEASE folio_request');
					return value;
				} catch (error) {
					db.exec('ROLLBACK TO folio_request');
					db.exec('RELEASE folio_request');
					throw error;
				}
			}
		}
	} as any,
	{} as any
);

const manifest = JSON.parse(
	readFileSync(join(consumer, 'assets/drupal-sql/manifest.json'), 'utf8')
);
for (let i = 0; i < manifest.totals.chunks; i++) {
	const chunk = JSON.parse(
		readFileSync(join(consumer, `assets/drupal-sql/${String(i).padStart(4, '0')}.json`), 'utf8')
	);
	for (const item of chunk.statements) sql.exec(item.s, ...item.p.map(decodeParam));
}
stage('seed-loaded', { chunks: manifest.totals.chunks, statements: manifest.totals.statements });
sqlTrace.length = 0;

const env = {
	ASSETS: {
		async fetch(input: Request | string | URL) {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const path = resolve(consumer, 'assets', '.' + decodeURIComponent(url.pathname));
			if (!path.startsWith(join(consumer, 'assets') + '/')) {
				return new Response('', { status: 400 });
			}
			try {
				return new Response(readFileSync(path));
			} catch {
				return new Response('', { status: 404 });
			}
		}
	}
};
const g = globalThis as any;
g.self ??= g;
g.location ??= new URL('https://folio.invalid/worker.mjs');
const { default: Factory } = await import(
	pathToFileURL(join(consumer, '.interp/php8.5-worker.tuned.mjs')).href
);
const original = readFileSync(join(consumer, '.interp/php8.5.tuned.wasm'));
result.original = { bytes: original.length, sha256: hash(original) };
const nativeModule = new WebAssembly.Module(original);

// preparing the shipping module takes about two minutes, so the plan is cached beside the output
function plan() {
	if (existsSync(planPath)) return deserialize(readFileSync(planPath));
	const prepared = prepare(original);
	writeFileSync(planPath, serialize(prepared));
	return prepared;
}

let pool: FolioPool | undefined;
let instantiationError: unknown;
const output: string[] = [];
const errors: string[] = [];
const php = new PhpBase(
	Promise.resolve({ default: Factory }) as any,
	{
		ini: [
			'opcache.enable=0',
			'opcache.enable_cli=0',
			'memory_limit=96M',
			`disable_functions=${DISABLED.join(',')}`
		].join('\n'),
		printErr: (text: string) => errors.push(text),
		onAbort: (text: unknown) => errors.push('abort: ' + String(text)),
		instantiateWasm(
			imports: WebAssembly.Imports,
			receive: (instance: any, module: WebAssembly.Module) => void
		) {
			(async () => {
				await Promise.resolve();
				(imports.env as any).memory = new WebAssembly.Memory(INTERPRETER_MEMORY);
				if (mode === 'native') {
					receive(new WebAssembly.Instance(nativeModule, imports), nativeModule);
				} else {
					const opened: FolioPool = await Folio.open(plan(), {
						imports,
						workers: Number(process.env.FOLIO_WORKERS ?? 2),
						profile: true
					});
					pool = opened;
					result.capabilities = opened.capabilities;
					result.threadIds = opened.threadIds;
					result.inspect = opened.inspect('pib_run');
					receive({ exports: opened.exports }, nativeModule);
				}
			})().catch((error) => {
				instantiationError = error;
				console.error(error);
				process.exitCode = 1;
			});
			return {};
		}
	} as any
) as any;
php.addEventListener('output', (event: any) => output.push(...[].concat(event.detail ?? [])));
php.addEventListener('error', (event: any) => errors.push(...[].concat(event.detail ?? [])));

async function run(code: string, parallel = false) {
	output.length = 0;
	if (parallel && pool) {
		const encoded = new TextEncoder().encode('?>' + code + '\0');
		const pointer = Number((pool.exports.malloc as CallableFunction)(encoded.length));
		try {
			new Uint8Array(pool.memory.buffer, pointer, encoded.length).set(encoded);
			result.reports.push(await pool.run('pib_run', [pointer]));
			php.flush();
		} finally {
			(pool.exports.free as CallableFunction)(pointer);
		}
	} else await php._run(code);
	return output.join('');
}

try {
	const binary = (await Promise.race([
		php.binary,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(instantiationError ?? new Error('interpreter bootstrap timeout')),
				600000
			).unref()
		)
	])) as any;
	stage('php-booted', { memoryBytes: binary.HEAPU8.buffer.byteLength });
	bridge.installBridge(binary);
	installZlib(binary, withMask);
	binary.cfwCanSuspend = false;
	binary.cfwStats = () =>
		JSON.stringify({ queryCount: bridge.queryCount, databaseSize: 0, oversized: false });
	binary.cfwServeStats = () => JSON.stringify({});
	const mount = await mountDrupalLazy(binary, env as any, { database: false });
	const driver = await mountDriver(binary, env as any);
	mkdirp(binary.FS, '/drupal/sites/default/files/config/sync');
	const settingsPath = '/drupal/sites/default/settings.php';
	const settings = new TextDecoder().decode(binary.FS.readFile(settingsPath));
	binary.FS.writeFile(
		settingsPath,
		settings +
			settingsOverride({
				origin: JSON.stringify('https://folio.invalid'),
				argon2: false,
				memoryBins: "['dynamic_page_cache','menu']",
				memoryItems: 64,
				lane: 0,
				lanes: 1,
				packageAutoload: '',
				deploymentEnv: ''
			}) +
			"\n$settings['hash_salt']='folio-render-proof-fixed-salt';\n"
	);
	binary.FS.writeFile('/drupal/sites/default/services.yml', SERVICES_YAML);
	stage('mounted', { mount, driver });
	for (const shim of [
		PHP_CODEC,
		MB_FIX,
		ICONV_FIX,
		ZLIB_FIX,
		CURL_FIX,
		OPENSSL_FIX,
		ARGON2_FIX,
		SODIUM_FIX,
		XMLWRITER_FIX,
		STANDIN_FIX
	]) {
		await run('<?php ' + shim);
	}
	const version = await run(
		'<?php echo json_encode(["version"=>PHP_VERSION,"intSize"=>PHP_INT_SIZE,"extensions"=>get_loaded_extensions()]);'
	);
	result.version = JSON.parse(version.slice(version.indexOf('{')));
	stage('shims-ready');
	const exceptionRaw = await run(
		'<?php try { (function() { throw new \\RuntimeException("folio-caught-unwind"); })(); } catch (\\Throwable $e) { echo json_encode(["caught"=>$e->getMessage()]); }',
		mode === 'folio'
	);
	result.exception = JSON.parse(exceptionRaw.slice(exceptionRaw.indexOf('{')));
	if (result.exception.caught !== 'folio-caught-unwind') {
		throw new Error('PHP exception continuation failed: ' + exceptionRaw);
	}
	const kernelRaw = await run(BOOT_KERNEL, mode === 'folio');
	result.kernelRaw = kernelRaw;
	const kernel = JSON.parse(kernelRaw.slice(kernelRaw.indexOf('{')));
	if (!kernel.ok || !kernel.hasDb) throw new Error('Drupal kernel failed: ' + kernelRaw);
	stage('drupal-booted', {
		kernel,
		queries: bridge.queryCount,
		memoryBytes: binary.HEAPU8.buffer.byteLength
	});
	const code = renderPage('/', ['page', 'dynamic_page_cache', 'render'], false, {
		origin: 'https://folio.invalid'
	});
	const renderedRaw = await run(code, mode === 'folio');
	const rendered = JSON.parse(renderedRaw.slice(renderedRaw.indexOf('{')));
	if (
		rendered.status !== 200 ||
		!rendered.html?.includes('<html') ||
		rendered.bytes < 1000 ||
		rendered.error
	) {
		throw new Error('Drupal render failed: ' + renderedRaw.slice(0, 2500));
	}
	if (rendered.pageCache === 'HIT' || rendered.dynamicCache === 'HIT') {
		throw new Error('render answered from Drupal cache');
	}
	writeFileSync(outPath + '.html', rendered.html);
	result.render = { ...rendered, html: undefined, sha256: hash(rendered.html) };
	result.sql = {
		queries: bridge.queryCount,
		rowsRead: bridge.rowsRead,
		rowsWritten: bridge.rowsWritten,
		statementShapeSha256: hash(JSON.stringify(sqlTrace)),
		callsIncludingCounters: sqlTrace.length
	};
	result.lazyInflation = mount.inflateStats;
	stage('drupal-rendered', {
		render: result.render,
		memoryBytes: binary.HEAPU8.buffer.byteLength,
		lazyInflation: mount.inflateStats
	});
	result.ok = true;
} catch (error) {
	result.error = String((error as Error)?.stack ?? error);
	console.error(error);
	process.exitCode = 1;
} finally {
	if (pool) await pool.close();
	db.close();
	result.errors = errors;
	stage('closed');
	writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
}
