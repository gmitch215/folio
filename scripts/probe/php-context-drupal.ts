import {
	mkdirp,
	mountDriver,
	mountDrupalLazy
} from 'consumer:node_modules/@drupflare/cartridge/src/fs.ts';
import { withMask } from 'consumer:node_modules/@drupflare/cartridge/src/mask.ts';
import 'consumer:node_modules/@drupflare/cartridge/src/worker-shim.ts';
import { PHP_CODEC } from 'consumer:node_modules/@drupflare/durabledb/src/codec.ts';
import { SiteDurableObject } from 'consumer:node_modules/@drupflare/durabledb/src/do-sqlite.ts';
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
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// one private database and one private lazy ROM mount per context; the seed files are read-only
let root = '';
let db: DatabaseSync;
let bridge: any;
const sqlStats = { ms: 0, calls: 0 };
const inflate = () => (globalThis as any).__inflate ?? { ms: 0, calls: 0, bytes: 0 };
const normalize = (html: string) =>
	html
		.replace(/(js-view-dom-id-)[0-9a-f]{64}/g, '$1')
		.replace(/("permissionsHash":")[0-9a-f]{64}/g, '$1');
let mountResult: any;
let queryBase = 0;

export interface SqlRecord {
	text: string;
	params: unknown[];
	rows: number;
	rowsWritten: number;
	ms: number;
}

const sqlLog: SqlRecord[] = [];
let sqlLogging = false;

/** blobs become their length and long strings are cut, so a log stays small */
function describeParam(value: unknown): unknown {
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		return { bytes: (value as ArrayBuffer).byteLength };
	if (typeof value === 'string' && value.length > 80) return value.slice(0, 80);
	return value;
}

export const startSqlLog = () => {
	sqlLog.length = 0;
	sqlLogging = true;
};

export const takeSqlLog = () => {
	sqlLogging = false;
	return sqlLog.splice(0);
};

export const database = () => db;
export const memory = () => INTERPRETER_MEMORY;
export const disabled = () => `disable_functions=${DISABLED.join(',')}`;

export async function prepare(consumer: string) {
	root = consumer;
	db = new DatabaseSync(':memory:');
	const sql = {
		exec(text: string, ...params: any[]) {
			const start = performance.now();
			const statement = db.prepare(text);
			const changes = () => db.prepare('SELECT total_changes() AS n').get()!.n as number;
			const before = changes();
			const rows = statement.all(
				...params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))
			);
			const ms = performance.now() - start;
			sqlStats.ms += ms;
			sqlStats.calls++;
			const rowsWritten = changes() - before;
			if (sqlLogging)
				sqlLog.push({
					text,
					params: params.map(describeParam),
					rows: rows.length,
					rowsWritten,
					ms
				});
			return { toArray: () => rows, rowsRead: rows.length, rowsWritten };
		}
	};
	bridge = new SiteDurableObject(
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
			readFileSync(
				join(consumer, `assets/drupal-sql/${String(i).padStart(4, '0')}.json`),
				'utf8'
			)
		);
		for (const item of chunk.statements) sql.exec(item.s, ...item.p.map(decodeParam));
	}
}

export async function boot(
	binary: any,
	run: (code: string) => Promise<string>,
	options: { jsOnly?: boolean; salt?: string } = {}
) {
	const env = {
		ASSETS: {
			async fetch(input: Request | string | URL) {
				const url = new URL(input instanceof Request ? input.url : String(input));
				const path = resolve(root, 'assets', '.' + decodeURIComponent(url.pathname));
				if (!path.startsWith(join(root, 'assets') + '/'))
					return new Response('', { status: 400 });
				try {
					return new Response(readFileSync(path));
				} catch {
					return new Response('', { status: 404 });
				}
			}
		}
	};
	bridge.installBridge(binary);
	installZlib(binary, withMask);
	binary.cfwCanSuspend = false;
	binary.cfwStats = () =>
		JSON.stringify({ queryCount: bridge.queryCount, databaseSize: 0, oversized: false });
	binary.cfwServeStats = () => JSON.stringify({});
	mountResult = await mountDrupalLazy(binary, env as any, { database: false });
	await mountDriver(binary, env as any);
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
			`\n$settings['hash_salt']='${options.salt ?? 'folio-render-proof-fixed-salt'}';\n`
	);
	binary.FS.writeFile('/drupal/sites/default/services.yml', SERVICES_YAML);
	if (options.jsOnly) return;
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
	const kernelRaw = await run(BOOT_KERNEL);
	const kernel = JSON.parse(kernelRaw.slice(kernelRaw.indexOf('{')));
	if (!kernel.ok || !kernel.hasDb) throw new Error('Drupal kernel failed: ' + kernelRaw);
}

export const renderCode = (
	path = '/',
	bins = ['page', 'dynamic_page_cache', 'render'],
	request: Record<string, unknown> = {}
) => renderPage(path, bins, false, { origin: 'https://folio.invalid', ...request });

export function resetSql() {
	sqlStats.ms = 0;
	sqlStats.calls = 0;
	const stats = (globalThis as any).__inflate;
	if (stats) Object.assign(stats, { ms: 0, calls: 0, bytes: 0 });
	queryBase = bridge.queryCount;
}

export function summarize(raw: string) {
	const rendered = JSON.parse(raw.slice(raw.indexOf('{')));
	if (rendered.status !== 200 || !rendered.html?.includes('<html') || rendered.bytes < 1000)
		throw new Error('Drupal render failed: ' + raw.slice(0, 1500));
	if (rendered.pageCache === 'HIT' || rendered.dynamicCache === 'HIT')
		throw new Error('render answered from Drupal cache');
	const stats = inflate();
	return {
		sha256: createHash('sha256').update(normalize(rendered.html)).digest('hex'),
		status: rendered.status,
		bytes: rendered.bytes,
		sqlMs: sqlStats.ms,
		sqlCalls: sqlStats.calls,
		queries: bridge.queryCount - queryBase,
		inflateMs: stats.ms,
		inflateCalls: stats.calls,
		inflateBytes: stats.bytes,
		resident: mountResult?.inflateStats?.residentBytes
	};
}

export function close() {
	db.close();
}
