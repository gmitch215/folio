import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { Agent, createServer, request, type Server } from 'node:http';
import { arch, cpus, freemem, homedir, loadavg, platform, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

// does a real Drupal site on workerd serve CPU-bound requests one at a time, and what do several
// workerd processes do for the same batch? Each host is one workerd with its own Durable Object
// files, planned by the self-hosted runtime's own planner and fed by its own adapters (its cgroup
// step is Linux only, so the runtime itself cannot start a tenant here).
// arms: queue-cN = one process, N requests in flight; static-N = N processes, one in flight each,
// request i goes to process i mod N; spin-cN = a JS spin loop on N threads, the CPU headroom control.
// usage: node scripts/probe/site-concurrency.ts OUTDIR [ROUNDS] [HOSTS]
//        bun scripts/probe/site-concurrency.ts host ROOT PAYLOAD   (one hosted site; internal)
// env: SITE_PAYLOAD (site.js, wasm files and assets/), SITE_CORE (the runtime's core directory),
// SITE_ASSET_PROFILE and SITE_PROBE (the runtime's names for the site's asset profile and probe),
// SITE_HEADER_PREFIX (prefix of the runtime's request headers), WORKERD_BINARY, FOLIO_MACHINE

export const batchSize = 31;
export type Kind = 'queue' | 'static' | 'spin';
export type Arm = { name: string; kind: Kind; c: number; hosts: number };

export const arms: Arm[] = [
	...[1, 2, 4, 8].map((c) => ({ name: `queue-c${c}`, kind: 'queue' as const, c, hosts: 1 })),
	...[2, 4, 8].map((n) => ({ name: `static-${n}`, kind: 'static' as const, c: n, hosts: n })),
	...[1, 2, 4, 8].map((c) => ({ name: `spin-c${c}`, kind: 'spin' as const, c, hosts: 0 }))
];

// item i goes to share i mod n
export const staticShares = <T>(items: T[], n: number): T[][] =>
	Array.from({ length: n }, (_, k) => items.filter((_, i) => i % n === k));

// `ps -o time` prints [[h:]m:]ss.cc
export const psTimeMs = (text: string): number => {
	const parts = text.trim().split(':').map(Number);
	if (parts.some((p) => !Number.isFinite(p))) throw new Error(`unreadable ps time: ${text}`);
	return Math.round(parts.reduce((total, p) => total * 60 + p, 0) * 1000);
};

export const parsePs = (out: string) =>
	new Map(
		out
			.trim()
			.split('\n')
			.map((line) => {
				const [pid, rss, time] = line.trim().split(/\s+/);
				return [Number(pid), { rssKb: Number(rss), cpuMs: psTimeMs(time!) }] as const;
			})
	);

export const readPs = (pids: number[]) =>
	parsePs(
		execFileSync('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], { encoding: 'utf8' })
	);

// macOS physical footprint, which counts pages the compressor holds and ps rss does not
export const parseFootprintMb = (out: string): number => {
	const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(out);
	if (!m) throw new Error('unreadable footprint output');
	return Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2] as 'KB' | 'MB' | 'GB'];
};

export const footprintMb = (pid: number) =>
	parseFootprintMb(execFileSync('footprint', [String(pid)], { encoding: 'utf8' }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #region host

const hostSite = async (root: string, payload: string) => {
	const core = process.env.SITE_CORE!;
	const profile = process.env.SITE_ASSET_PROFILE!;
	const headerPrefix = process.env.SITE_HEADER_PREFIX!;
	const workerd = process.env.WORKERD_BINARY!;
	const load = (path: string) => import(pathToFileURL(join(core, 'src', path)).href);
	const [assets, cache, generate, plan, context, kv, files, server] = await Promise.all([
		load('adapters/assets.ts'),
		load('adapters/cache.ts'),
		load('capnp/generate.ts'),
		load('capnp/plan.ts'),
		load('context.ts'),
		load('drivers/memory-kv.ts'),
		load('host/files.ts'),
		load('adapters/server.ts')
	]);
	const listen = join(root, 'http.sock');
	mkdirSync(join(root, 'storage'), { recursive: true });
	const adapters = {
		cache: cache.memoryCacheStore(),
		kv: kv.memoryKv(),
		r2: kv.memoryKv(),
		queues: kv.memoryKv(),
		assets: assets.assetResolver(
			files.nodeFiles(),
			join(payload, 'assets'),
			assets.ASSET_PROFILES[profile]
		),
		tenant: 'acme'
	};
	const servers: Server[] = [];
	for (const slot of server.ADAPTER_SLOTS as string[]) {
		const http = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(req.headers))
					if (
						typeof value === 'string' &&
						(name === 'content-type' || name.startsWith(headerPrefix))
					)
						headers[name] = value;
				const url = new URL(`http://runtime${req.url ?? '/'}`);
				const asked = new Request(url, {
					method: req.method,
					headers,
					...(req.method === 'GET' || req.method === 'HEAD'
						? {}
						: { body: Buffer.concat(chunks) })
				});
				server
					.handleSlot(adapters, slot, asked, url.pathname)
					.then(async (answer: Response) => {
						const out: Record<string, string> = {};
						answer.headers.forEach((value, name) => (out[name] = value));
						res.writeHead(answer.status, out);
						res.end(Buffer.from(await answer.arrayBuffer()));
					})
					.catch((error: unknown) => {
						console.error(`adapter ${slot}: ${String(error)}`);
						res.writeHead(500);
						res.end(String(error));
					});
			});
		});
		await new Promise<void>((done) =>
			http.listen(plan.socketFor({ adapterDir: root }, slot), done)
		);
		servers.push(http);
	}
	const config = plan.planSite({
		tenant: { name: 'acme', sites: [] },
		site: { host: '127.0.0.1', bundle: payload, probe: process.env.SITE_PROBE! },
		paths: {
			bundle: payload,
			storage: join(root, 'storage'),
			assets: join(payload, 'assets'),
			adapterDir: root,
			listenSocket: listen
		},
		modules: plan.modulesFrom(context.defaultContext(), payload, 'site.js', root),
		compatibilityDate: '2026-08-01',
		compatibilityFlags: ['nodejs_compat'],
		uniqueKey: 'site-probe',
		durableObjectClass: 'SitePhpDurableObject',
		residency: 'evict',
		bindings: {
			durableObject: 'SITE',
			assets: 'ASSETS',
			kv: ['CONFIG_KV', 'PAGE_KV'],
			r2: [],
			queues: []
		},
		vars: { PLAN: 'free', LAZY_MOUNT: '1' }
	});
	const configPath = join(root, 'config.capnp');
	writeFileSync(configPath, generate.renderConfig(config));
	const child = spawn(workerd, ['serve', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
	child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
	child.on('exit', (code) => process.exit(code ?? 1));
	const stop = () => {
		child.kill('SIGTERM');
		for (const http of servers) http.close();
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	console.log(JSON.stringify({ spawned: true, pid: child.pid, socket: listen }));
};

// #endregion

// #region client

type Reply = {
	status: number;
	ms: number;
	cache: string;
	workerMs: number;
	gateAhead: number;
	bytes: number;
};

const agents = new Map<string, Agent>();
export const get = (socket: string, path: string): Promise<Reply> =>
	new Promise((resolveReply, reject) => {
		let agent = agents.get(socket);
		if (!agent) agents.set(socket, (agent = new Agent({ keepAlive: true, maxSockets: 64 })));
		const t0 = performance.now();
		const req = request(
			{ socketPath: socket, path, agent, headers: { host: '127.0.0.1' } },
			(res) => {
				let bytes = 0;
				res.on('data', (chunk: Buffer) => (bytes += chunk.length));
				res.on('end', () =>
					resolveReply({
						status: res.statusCode ?? 0,
						ms: performance.now() - t0,
						cache: String(res.headers['x-cfw-cache'] ?? ''),
						workerMs: Number(res.headers['x-worker-ms'] ?? -1),
						gateAhead: Number(res.headers['x-cfw-gate-ahead'] ?? -1),
						bytes
					})
				);
			}
		);
		req.on('error', reject);
		req.end();
	});

let counter = 0;
const nonce = `${Date.now().toString(36)}`;
export const uniquePath = () => `/?cfwe=${nonce}-${counter++}`;

type Host = { root: string; socket: string; workerd: number; bun: number; child: ChildProcess };

async function startHost(index: number, base: string, payload: string): Promise<[Host, object]> {
	const root = join(base, `h${index}`);
	mkdirSync(root);
	const bun = process.env.BUN ?? join(homedir(), '.bun/bin/bun');
	const t0 = performance.now();
	const child = spawn(bun, [import.meta.filename, 'host', root, payload], {
		stdio: ['ignore', 'pipe', openSync(join(base, `h${index}.err`), 'w')]
	});
	const spawned = await new Promise<{ pid: number; socket: string }>((done, fail) => {
		child.on('exit', (code) => fail(new Error(`host ${index} exited ${code}`)));
		child.stdout!.once('data', (chunk: Buffer) => done(JSON.parse(chunk.toString())));
	});
	const host: Host = {
		root,
		socket: spawned.socket,
		workerd: spawned.pid,
		bun: child.pid!,
		child
	};
	// the first request starts a pack replay and answers 503 until it ends
	let first: Reply | undefined;
	for (;;) {
		try {
			first = await get(host.socket, '/');
			if (first.status !== 503) break;
		} catch {
			// workerd has not bound its socket yet
		}
		if (performance.now() - t0 > 300_000) throw new Error(`host ${index} never left 503`);
		await sleep(250);
	}
	const readyMs = performance.now() - t0;
	const warm: Reply[] = [];
	for (let i = 0; i < 3; i++) warm.push(await get(host.socket, uniquePath()));
	const ps = readPs([host.workerd, host.bun]);
	return [
		host,
		{
			kind: 'boot',
			host: index,
			readyMs,
			firstStatus: first.status,
			warmMs: warm.map((w) => w.ms),
			warmCache: warm.map((w) => w.cache),
			warmStatus: warm.map((w) => w.status),
			workerdRssKb: ps.get(host.workerd)!.rssKb,
			workerdCpuMs: ps.get(host.workerd)!.cpuMs,
			bunRssKb: ps.get(host.bun)!.rssKb,
			bunCpuMs: ps.get(host.bun)!.cpuMs,
			workerdFootprintMb: footprintMb(host.workerd),
			bunFootprintMb: footprintMb(host.bun)
		}
	];
}

// #endregion

// #region spin control

const spinSource = `const { parentPort } = require('node:worker_threads');
parentPort.on('message', (n) => {
	let x = 1;
	for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	parentPort.postMessage(x);
});`;

const spinOnce = (worker: Worker, n: number) =>
	new Promise<void>((done) => {
		worker.once('message', () => done());
		worker.postMessage(n);
	});

const spinPool = async (size: number, iterations: number) => {
	const pool = Array.from({ length: size }, () => new Worker(spinSource, { eval: true }));
	await Promise.all(pool.map((worker) => spinOnce(worker, iterations)));
	return pool;
};

const calibrateSpin = (targetMs: number) => {
	let x = 1;
	const n = 5e7;
	const t0 = performance.now();
	for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	const per = (performance.now() - t0) / n;
	return { iterations: Math.round(targetMs / per), check: x };
};

// #endregion

type Sample = Record<string, unknown>;

// width workers take the next item from one queue until it is empty
export async function drainQueue<T>(
	items: string[],
	width: number,
	run: (item: string, worker: number) => Promise<T>
) {
	const queue = [...items];
	const done: T[] = [];
	await Promise.all(
		Array.from({ length: width }, async (_, worker) => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift())
				done.push(await run(item, worker));
		})
	);
	return done;
}

async function main(outDir: string, rounds: number, hostCount: number) {
	const root = resolve(import.meta.dirname, '../..');
	const payload = resolve(process.env.SITE_PAYLOAD ?? '');
	const workerd = process.env.WORKERD_BINARY ?? join(root, 'node_modules/workerd/bin/workerd');
	process.env.WORKERD_BINARY = workerd;
	mkdirSync(outDir, { recursive: true });
	const samples = join(outDir, 'samples.jsonl');
	writeFileSync(samples, '');
	const emit = (row: Sample) => appendFileSync(samples, `${JSON.stringify(row)}\n`);

	const active = arms.filter((a) => a.hosts <= hostCount);
	const base = mkdtempSync(join(tmpdir(), 'fsc-'));
	const hosts: Host[] = [];
	const stopAll = async () => {
		for (const host of hosts) host.child.kill('SIGTERM');
		await sleep(500);
		const errors = new Map<string, number>();
		for (let i = 0; i < hosts.length; i++)
			for (const line of readFileSync(join(base, `h${i}.err`), 'utf8').split('\n'))
				if (line.includes('error')) {
					const key = line.replace(/wdErrId = \w+|stack: .*/g, '').trim();
					errors.set(key, (errors.get(key) ?? 0) + 1);
				}
		emit({ kind: 'hostLog', errors: Object.fromEntries(errors) });
		if (base.startsWith(join(tmpdir(), 'fsc-'))) rmSync(base, { recursive: true, force: true });
	};
	try {
		const spin = calibrateSpin(44);
		const pool = await spinPool(8, spin.iterations);
		const siteSha = createHash('sha256')
			.update(readFileSync(join(payload, 'site.js')))
			.digest('hex');
		emit({
			kind: 'environment',
			experiment: 'real Drupal payload on workerd: one process against several processes',
			machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
			platform: `${platform()} ${arch()}`,
			cpu: cpus()[0]!.model,
			hardwareThreads: cpus().length,
			node: process.version,
			workerd: execFileSync(workerd, ['--version'], { encoding: 'utf8' }).trim(),
			payloadSiteJsSha256: siteSha,
			batchSize,
			rounds,
			hostCount,
			arms: active.map((a) => a.name),
			spinIterations: spin.iterations,
			totalMemMb: Math.round(totalmem() / 2 ** 20),
			freeMemMb: Math.round(freemem() / 2 ** 20),
			load: loadavg()
		});

		for (let i = 0; i < hostCount; i++) {
			const [host, boot] = await startHost(i, base, payload);
			hosts.push(host);
			emit({ ...boot, load: loadavg() });
		}

		const sampleArm = async (arm: Arm, round: number): Promise<Sample> => {
			const urls = Array.from({ length: batchSize }, uniquePath);
			const used = hosts.slice(0, arm.hosts);
			const pids = used.flatMap((h) => [h.workerd, h.bun]);
			const ps0 = pids.length
				? readPs(pids)
				: new Map<number, { rssKb: number; cpuMs: number }>();
			const cpu0 = process.cpuUsage();
			const wall0 = performance.now();
			let replies: { host: number; reply: Reply }[] = [];
			let spinMs: number[] = [];
			if (arm.kind === 'queue') {
				replies = (await drainQueue(urls, arm.c, (u) => get(used[0]!.socket, u))).map(
					(reply) => ({
						host: 0,
						reply
					})
				);
			} else if (arm.kind === 'static') {
				const shares = staticShares(urls, arm.hosts);
				const done = await Promise.all(
					shares.map(async (share, k) => {
						const out: { host: number; reply: Reply }[] = [];
						for (const u of share)
							out.push({ host: k, reply: await get(used[k]!.socket, u) });
						return out;
					})
				);
				replies = done.flat();
			} else {
				spinMs = await drainQueue(urls, arm.c, async (_, worker) => {
					const t0 = performance.now();
					await spinOnce(pool[worker]!, spin.iterations);
					return performance.now() - t0;
				});
			}
			const wallMs = performance.now() - wall0;
			const cpu = process.cpuUsage(cpu0);
			const ps1 = pids.length ? readPs(pids) : ps0;
			const perHost = used.map((h) => ({
				workerdCpuMs: ps1.get(h.workerd)!.cpuMs - ps0.get(h.workerd)!.cpuMs,
				bunCpuMs: ps1.get(h.bun)!.cpuMs - ps0.get(h.bun)!.cpuMs,
				workerdRssKb: ps1.get(h.workerd)!.rssKb,
				bunRssKb: ps1.get(h.bun)!.rssKb
			}));
			return {
				kind: 'sample',
				round,
				arm: arm.name,
				armKind: arm.kind,
				c: arm.c,
				hosts: arm.hosts,
				requests: batchSize,
				wallMs,
				ms: replies.map((r) => r.reply.ms),
				spinMs,
				status: replies.map((r) => r.reply.status),
				cache: replies.map((r) => r.reply.cache),
				gateAhead: replies.map((r) => r.reply.gateAhead),
				workerMs: replies.map((r) => r.reply.workerMs),
				perHostRequests: used.map((_, k) => replies.filter((r) => r.host === k).length),
				perHost,
				clientCpuMs: (cpu.user + cpu.system) / 1000,
				load: loadavg()
			};
		};

		for (let round = 0; round < rounds; round++)
			for (let k = 0; k < active.length; k++)
				emit(await sampleArm(active[(k + round) % active.length]!, round));
		const end = readPs(hosts.flatMap((h) => [h.workerd, h.bun]));
		emit({
			kind: 'memory',
			freeMemMb: Math.round(freemem() / 2 ** 20),
			hosts: hosts.map((h) => ({
				workerdRssKb: end.get(h.workerd)!.rssKb,
				bunRssKb: end.get(h.bun)!.rssKb,
				workerdFootprintMb: footprintMb(h.workerd),
				bunFootprintMb: footprintMb(h.bun)
			}))
		});
		for (const worker of pool) void worker.terminate();
	} finally {
		await stopAll();
	}
}

if (import.meta.main) {
	const [first, ...rest] = process.argv.slice(2);
	if (first === 'host') await hostSite(rest[0]!, rest[1]!);
	else {
		if (!first) throw new Error('usage: site-concurrency.ts OUTDIR [ROUNDS] [HOSTS]');
		await main(first, Number(rest[0] ?? 24), Number(rest[1] ?? 8));
	}
}
