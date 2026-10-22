import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface Credentials {
	account: string;
	token: string;
	label: 'FREE' | 'STUDENT';
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

// FREE_* is the account the e2e workflow holds; STUDENT_* is what the recorded runs used
export function credentials(): Credentials {
	for (const label of ['FREE', 'STUDENT'] as const) {
		const account = process.env[`${label}_CLOUDFLARE_ACCOUNT_ID`];
		const token = process.env[`${label}_CLOUDFLARE_API_TOKEN`];
		if (account && token) return { account, token, label };
	}
	throw new Error('set FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN');
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
