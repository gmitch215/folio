import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface Credentials {
	account: string;
	token: string;
	label: 'FREE' | 'SELECTED';
}

export interface Snapshot {
	scripts: string[];
	namespaces: string[];
	kv: string[] | null;
	r2: string[] | null;
	d1: string[] | null;
}

export interface Child {
	process: ChildProcess;
	done: Promise<void>;
}

export const classesFor = {
	cloud: ['Lane', 'Coordinator'],
	managed: ['ManagedLane', 'ManagedOwner'],
	browser: ['BrowserGate'],
	consumer: ['ConsumerGate'],
	php: ['PhpProbe'],
	prepared: ['PhpProbe'],
	bootimage: ['BootImage']
} as const;

export type Kind = keyof typeof classesFor;

export const isKind = (value: unknown): value is Kind =>
	typeof value === 'string' && value in classesFor;

// FOLIO_CLOUDFLARE_* names the account to use; FREE_CLOUDFLARE_* is the Free plan account CI holds
export function credentials(env: Record<string, string | undefined> = process.env): Credentials {
	for (const [prefix, label] of [
		['FOLIO', 'SELECTED'],
		['FREE', 'FREE']
	] as const) {
		const account = env[`${prefix}_CLOUDFLARE_ACCOUNT_ID`];
		const token = env[`${prefix}_CLOUDFLARE_API_TOKEN`];
		if (account && token) return { account, token, label };
	}
	throw new Error('set FOLIO_CLOUDFLARE_ACCOUNT_ID and FOLIO_CLOUDFLARE_API_TOKEN');
}

export function createApi({ account, token }: Credentials) {
	const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
	return async function api(path: string, init: RequestInit = {}): Promise<any> {
		const response = await fetch(`${base}${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
			signal: AbortSignal.timeout(30000)
		});
		const result: any = await response.json();
		if (!response.ok || !result.success)
			throw new Error(`${path}: ${JSON.stringify(result.errors)}`);
		return result.result;
	};
}

export type Api = ReturnType<typeof createApi>;

// a list the token cannot read is recorded as null, so before and after still compare
const optional = (
	promise: Promise<any>,
	key: (row: any) => string,
	pick = (result: any) => result
) =>
	promise.then(
		(result) => pick(result).map(key).sort() as string[],
		() => null
	);

export async function snapshot(api: Api): Promise<Snapshot> {
	const [scripts, namespaces, kv, r2, d1] = await Promise.all([
		api('/workers/scripts'),
		api('/workers/durable_objects/namespaces'),
		optional(api('/storage/kv/namespaces'), (row) => row.id),
		optional(
			api('/r2/buckets'),
			(row) => row.name,
			(result) => result.buckets ?? result
		),
		optional(api('/d1/database'), (row) => row.uuid)
	]);
	return {
		scripts: scripts.map((row: { id: string }) => row.id).sort(),
		namespaces: namespaces.map((row: { id: string }) => row.id).sort(),
		kv,
		r2,
		d1
	};
}

/** names and modified times of what the account lists, so two of these show what changed between them */
export async function inventory(api: Api) {
	const list = async (
		path: string,
		pick: (row: any) => Record<string, unknown>,
		unwrap = (x: any) => x
	) => {
		try {
			return (unwrap(await api(path)) as any[]).map(pick);
		} catch {
			return null;
		}
	};
	return {
		scripts: await list('/workers/scripts', (r) => ({
			name: r.id,
			modified: r.modified_on,
			created: r.created_on
		})),
		namespaces: await list('/workers/durable_objects/namespaces', (r) => ({
			name: r.name,
			script: r.script,
			class: r.class,
			id: r.id
		})),
		kv: await list('/storage/kv/namespaces?per_page=100', (r) => ({ name: r.title, id: r.id })),
		r2: await list(
			'/r2/buckets',
			(r) => ({ name: r.name, created: r.creation_date }),
			(x) => x.buckets ?? x
		),
		d1: await list('/d1/database', (r) => ({ name: r.name, created: r.created_at, id: r.uuid }))
	};
}

export type Inventory = Awaited<ReturnType<typeof inventory>>;

/**
 * What differs between two inventories. `mine` says whether an entry belongs to the caller; a
 * difference that is not the caller's carries only a short hash of its name, never the name.
 */
export function inventoryDiff(
	before: Inventory,
	after: Inventory,
	mine: (entry: Record<string, unknown>) => boolean
) {
	const out: { type: string; change: string; mine: boolean; ref: string }[] = [];
	for (const type of Object.keys(before) as (keyof Inventory)[]) {
		const a = before[type];
		const b = after[type];
		if (a === null || b === null) {
			if (a !== b) out.push({ type, change: 'unreadable', mine: false, ref: '' });
			continue;
		}
		const key = (e: Record<string, unknown>) => JSON.stringify([e.name, e.id ?? '']);
		const was = new Map(a.map((e) => [key(e), JSON.stringify(e)]));
		const now = new Map(b.map((e) => [key(e), JSON.stringify(e)]));
		const entries = new Map([...a, ...b].map((e) => [key(e), e]));
		for (const [k, e] of entries) {
			const change = !was.has(k)
				? 'added'
				: !now.has(k)
					? 'removed'
					: was.get(k) !== now.get(k)
						? 'modified'
						: '';
			if (!change) continue;
			const own = mine(e);
			out.push({
				type,
				change,
				mine: own,
				ref: own
					? String(e.name ?? '')
					: createHash('sha256').update(k).digest('hex').slice(0, 8)
			});
		}
	}
	return out;
}

// a Durable Object script cannot be deleted while it owns classes, so retire the classes first
export async function retire(
	api: Api,
	name: string,
	classes: readonly string[],
	tags: { old: string; next: string } = { old: 'v1', next: 'v2' }
) {
	const body = new FormData();
	body.set(
		'metadata',
		new Blob(
			[
				JSON.stringify({
					main_module: 'retire.mjs',
					compatibility_date: '2026-10-20',
					bindings: [],
					migrations: {
						old_tag: tags.old,
						new_tag: tags.next,
						steps: [{ deleted_classes: classes }]
					}
				})
			],
			{ type: 'application/json' }
		)
	);
	body.set(
		'retire.mjs',
		new Blob(
			['export default { fetch() { return new Response("retired", { status: 410 }); } };'],
			{
				type: 'application/javascript+module'
			}
		),
		'retire.mjs'
	);
	await api(`/workers/scripts/${name}`, { method: 'PUT', body });
	await api(`/workers/scripts/${name}`, { method: 'DELETE' });
}

export const wranglerPath = () =>
	process.env.FOLIO_WRANGLER ??
	join(
		dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
		'bin/wrangler.js'
	);

// the consumer, php and prepared probes share one directory
export const runDirectory = (kind: Kind) =>
	kind === 'consumer' || kind === 'php' || kind === 'prepared' ? 'consumer' : kind;

export async function openRun(kind: Kind, name: string) {
	const directory = new URL(`../${runDirectory(kind)}/runs/${name}/`, import.meta.url);
	await mkdir(directory, { recursive: true });
	return {
		directory,
		save: (file: string, value: unknown) =>
			writeFile(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, {
				flag: 'wx'
			})
	};
}

export function spawnWrangler(
	credentials: Credentials,
	args: string[],
	log: URL,
	options: { cwd: URL; input?: string }
): Child {
	const stream = createWriteStream(log, { flags: 'wx' });
	const child = spawn(process.execPath, [wranglerPath(), ...args], {
		cwd: options.cwd,
		env: {
			...process.env,
			CLOUDFLARE_ACCOUNT_ID: credentials.account,
			CLOUDFLARE_API_TOKEN: credentials.token,
			WRANGLER_SEND_METRICS: 'false'
		},
		stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
	});
	child.stdout!.pipe(stream, { end: false });
	child.stderr!.pipe(stream, { end: false });
	if (options.input !== undefined) child.stdin!.end(options.input);
	const done = new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => {
			stream.end();
			code === 0
				? resolve()
				: reject(new Error(`wrangler exit ${code} ${signal}; see ${log.pathname}`));
		});
	});
	return { process: child, done };
}

export async function stopTail(tail: Child | undefined) {
	const child = tail?.process;
	if (!tail || !child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGINT');
	await tail.done.catch(() => {});
}
