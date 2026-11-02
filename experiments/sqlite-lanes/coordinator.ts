import { DurableObject } from 'cloudflare:workers';
import sqlite from './build/sqlite-lanes.wasm';
import { UnsupportedQuery, catalog, ranges, shardable, wholeRange } from './queries.ts';
import { Sqlite, sharedMemory } from './sqlite.ts';

// the isolate holds 128 MB; the image, the module and the query heap must fit under this
const MAX_PAGES = 2048;
const SETS = ['serial', 'shards-4', 'shards-8'];

export interface Part {
	sha256: string;
	total: number;
	offset: number;
	partSha256: string;
	bytes: ArrayBuffer;
}

interface Staging {
	db: Sqlite;
	sha256: string;
	total: number;
	next: number;
}

async function sha256Hex(bytes: ArrayBuffer) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// one retained SQLite instance over one image; the image identity is the sha256 the owner sends
export class ShardObject extends DurableObject {
	private db?: Sqlite;
	private sha?: string;
	private staging?: Staging;

	async load(part: Part) {
		const bytes = new Uint8Array(part.bytes);
		if ((await sha256Hex(part.bytes)) !== part.partSha256)
			throw new Error('part hash mismatch');
		if (part.offset === 0) {
			this.db = undefined;
			this.sha = undefined;
			const db = new Sqlite(sqlite, sharedMemory(MAX_PAGES));
			db.beginImage(part.total);
			this.staging = { db, sha256: part.sha256, total: part.total, next: 0 };
		}
		const staged = this.staging;
		if (
			!staged ||
			part.offset !== staged.next ||
			part.sha256 !== staged.sha256 ||
			part.total !== staged.total
		)
			throw new Error(`part at ${part.offset} does not follow the staged image`);
		staged.db.writeImage(part.offset, bytes);
		staged.next += bytes.length;
		if (staged.next < staged.total) return { loaded: false, next: staged.next };
		staged.db.openImage();
		this.db = staged.db;
		this.sha = staged.sha256;
		this.staging = undefined;
		return { loaded: true, next: staged.next };
	}

	// warm means the instance was already open when this request arrived; miss means the owner must reload
	query(sha256: string, sql: string) {
		const warm = this.db !== undefined;
		if (!this.db || this.sha !== sha256) return { miss: true, warm, text: '', vmSteps: 0 };
		const { text, vmSteps } = this.db.query(sql);
		return { miss: false, warm, text, vmSteps };
	}
}

interface ShardStub {
	load(part: Part): Promise<{ loaded: boolean; next: number }>;
	query(
		sha256: string,
		sql: string
	): Promise<{ miss: boolean; warm: boolean; text: string; vmSteps: number }>;
}

interface Env {
	PROBE_TOKEN: string;
	SHARDS: { idFromName(name: string): unknown; get(id: unknown): ShardStub };
}

const param = (url: URL, key: string) => {
	const value = url.searchParams.get(key);
	if (value === null) throw new UnsupportedQuery(`missing ${key}`);
	return value;
};

function stubFor(env: Env, run: string, set: string, slot: number) {
	return env.SHARDS.get(env.SHARDS.idFromName(`${run}/${set}/${slot}`));
}

async function load(env: Env, url: URL, request: Request) {
	const set = param(url, 'set');
	if (!SETS.includes(set)) return Response.json({ error: 'unknown set' }, { status: 400 });
	const part: Part = {
		sha256: param(url, 'sha'),
		total: Number(param(url, 'total')),
		offset: Number(param(url, 'offset')),
		partSha256: param(url, 'partSha'),
		bytes: await request.arrayBuffer()
	};
	const stub = stubFor(env, param(url, 'run'), set, Number(param(url, 'slot')));
	return Response.json(await stub.load(part));
}

// shard arms call every shard at once; the reference arm runs the unsplit serial text once per query
async function run(env: Env, url: URL) {
	const arm = param(url, 'arm');
	const name = param(url, 'query');
	const rows = Number(param(url, 'rows'));
	const runId = param(url, 'run');
	const shas = param(url, 'shas').split(',');
	const entry = catalog[name];
	if (!entry) throw new UnsupportedQuery(`unknown query ${JSON.stringify(name)}`);
	let width = 1;
	let sqls: string[];
	let set = 'serial';
	if (arm === 'reference') sqls = [entry.serial()];
	else if (arm === 'serial') sqls = [shardable(name).partial(wholeRange(rows))];
	else if (SETS.includes(arm) && arm.startsWith('shards-')) {
		const decomposable = shardable(name);
		width = Number(arm.slice('shards-'.length));
		set = arm;
		sqls = ranges(width, rows).map((r) => decomposable.partial(r));
	} else return Response.json({ error: `unknown arm ${arm}` }, { status: 400 });
	if (shas.length !== sqls.length)
		return Response.json({ error: 'one sha per slot' }, { status: 400 });

	const calls = await Promise.all(
		sqls.map(async (sql, slot) => {
			const result = await stubFor(env, runId, set, slot).query(shas[slot]!, sql);
			return { slot, ...result };
		})
	);
	const misses = calls.filter((c) => c.miss).map((c) => c.slot);
	if (misses.length) return Response.json({ miss: misses }, { status: 409 });
	const merged =
		arm.startsWith('shards-') && entry.decomposes
			? entry.merge(calls.map((c) => c.text))
			: undefined;
	return Response.json({
		arm,
		query: name,
		rows,
		calls: calls.map(({ slot, warm, vmSteps, text }) => ({ slot, warm, vmSteps, text })),
		merged
	});
}

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		try {
			if (url.pathname === '/ready') return new Response('ready');
			if (url.pathname === '/load' && request.method === 'POST')
				return await load(env, url, request);
			if (url.pathname === '/run') return await run(env, url);
		} catch (error) {
			if (error instanceof UnsupportedQuery)
				return Response.json({ error: error.message }, { status: 400 });
			return Response.json(
				{ error: String((error as Error)?.message ?? error) },
				{ status: 500 }
			);
		}
		return new Response('not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
