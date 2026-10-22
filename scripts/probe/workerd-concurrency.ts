import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { arch, cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';

// does stock workerd run CPU-bound requests in parallel?
// arms: a = one process, one worker; b = one process, four workers behind a round-robin front;
// c = one process, four workers on four sockets; d = four processes, one worker each.
// usage: node scripts/probe/workerd-concurrency.ts OUTDIR [ROUNDS]
// Mac only. The workerd binary is node_modules/workerd/bin/workerd.

export const arms = ['a', 'b', 'c', 'd'] as const;
export type Arm = (typeof arms)[number];
export const ks = [1, 2, 4, 8, 16];

// same loop as workerSource; the unit test checks the two agree on the first step
export const spin = (n: number) => {
	let x = 1;
	for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	return x;
};

export const workerSource = `const spin = (n) => {
  let x = 1;
  for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
  return x;
};
export default {
  fetch(request) {
    const n = Number(new URL(request.url).searchParams.get('n'));
    return new Response(String(spin(n)));
  },
};
`;

export const frontSource = `let next = 0;
export default {
  fetch(request, env) {
    const targets = [env.W0, env.W1, env.W2, env.W3];
    return targets[next++ % targets.length].fetch(request);
  },
};
`;

export type Service = { name: string; source: string; bindings?: [string, string][] };
export type Socket = { name: string; address: string; service: string };

const q = (s: string) => JSON.stringify(s);

const at = <T>(xs: readonly T[], i: number): T => {
	const v = xs[i];
	if (v === undefined) throw new RangeError(`index ${i} outside ${xs.length} items`);
	return v;
};

export const workerdConfig = (services: Service[], sockets: Socket[]) => {
	const out = ['using Workerd = import "/workerd/workerd.capnp";', ''];
	for (const s of services) {
		const bindings = s.bindings?.length
			? `\tbindings = [${s.bindings.map(([name, service]) => `(name = ${q(name)}, service = ${q(service)})`).join(', ')}],\n`
			: '';
		out.push(
			`const ${s.name} :Workerd.Worker = (`,
			`\tmodules = [(name = "index.js", esModule = ${q(s.source)})],`,
			'\tcompatibilityDate = "2025-01-01",',
			bindings + ');',
			''
		);
	}
	out.push('const config :Workerd.Config = (', '\tservices = [');
	for (const s of services) out.push(`\t\t(name = ${q(s.name)}, worker = .${s.name}),`);
	out.push('\t],', '\tsockets = [');
	for (const s of sockets)
		out.push(
			`\t\t(name = ${q(s.name)}, address = ${q(s.address)}, http = (), service = ${q(s.service)}),`
		);
	out.push('\t],', ');');
	return out.join('\n') + '\n';
};

export type Process = { name: string; config: string; ports: number[] };
export type Plan = { processes: Process[]; targets: number[] };

const addr = (port: number) => `127.0.0.1:${port}`;
const worker = (name: string) => ({ name, source: workerSource });

// ports: a takes 1, b takes 1, c takes 4, d takes 4 (in that order).
export const planArm = (arm: Arm, ports: number[]): Plan => {
	if (arm === 'a') {
		const p = at(ports, 0);
		const config = workerdConfig(
			[worker('main')],
			[{ name: 'http', address: addr(p), service: 'main' }]
		);
		return { processes: [{ name: 'a', config, ports: [p] }], targets: [p] };
	}
	if (arm === 'b') {
		const p = at(ports, 0);
		const services = [
			...[0, 1, 2, 3].map((i) => worker(`w${i}`)),
			{
				name: 'front',
				source: frontSource,
				bindings: [0, 1, 2, 3].map((i) => [`W${i}`, `w${i}`] as [string, string])
			}
		];
		const config = workerdConfig(services, [
			{ name: 'http', address: addr(p), service: 'front' }
		]);
		return { processes: [{ name: 'b', config, ports: [p] }], targets: [p] };
	}
	if (arm === 'c') {
		const sockets = ports
			.slice(0, 4)
			.map((p, i) => ({ name: `s${i}`, address: addr(p), service: `w${i}` }));
		const config = workerdConfig(
			[0, 1, 2, 3].map((i) => worker(`w${i}`)),
			sockets
		);
		return {
			processes: [{ name: 'c', config, ports: ports.slice(0, 4) }],
			targets: ports.slice(0, 4)
		};
	}
	const processes = ports.slice(0, 4).map((p, i) => ({
		name: `d${i}`,
		config: workerdConfig(
			[worker('main')],
			[{ name: 'http', address: addr(p), service: 'main' }]
		),
		ports: [p]
	}));
	return { processes, targets: ports.slice(0, 4) };
};

export const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? at(s, m) : (at(s, m - 1) + at(s, m)) / 2;
};

export const percentile = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return at(s, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
};

// n0 spins took median(samplesMs); scale so one request takes targetMs.
export const calibrateN = (samplesMs: number[], n0: number, targetMs = 100) =>
	Math.round((n0 * targetMs) / median(samplesMs));

export type Row = {
	arm: Arm;
	k: number;
	round: number;
	warmup: boolean;
	wallMs: number;
	latenciesMs: number[];
	ok: boolean;
	load1: number;
};

export const analyze = (rows: Row[]) => {
	const measured = rows.filter((r) => !r.warmup);
	const single = measured.filter((r) => r.arm === 'a' && r.k === 1).map((r) => r.wallMs);
	if (!single.length) throw new Error('no measured arm a k=1 rows');
	const baseMs = median(single);
	const cells = [];
	for (const arm of arms)
		for (const k of ks) {
			const rs = measured.filter((r) => r.arm === arm && r.k === k);
			if (!rs.length) continue;
			const walls = rs.map((r) => r.wallMs);
			const med = median(walls);
			const min = Math.min(...walls);
			const max = Math.max(...walls);
			// same-round K=1 of this arm; cancels the per-process speed drift between arms
			const selfs = rs.flatMap((r) => {
				const one = measured.find((x) => x.arm === arm && x.k === 1 && x.round === r.round);
				return one ? [(k * one.wallMs) / r.wallMs] : [];
			});
			cells.push({
				arm,
				k,
				n: rs.length,
				medianWallMs: med,
				minWallMs: min,
				maxWallMs: max,
				p95WallMs: percentile(walls, 95),
				speedup: (k * baseMs) / med,
				selfSpeedup: selfs.length ? median(selfs) : null,
				spreadPct: ((max - min) / med) * 100,
				medianResponseMs: median(rs.flatMap((r) => r.latenciesMs)),
				ok: rs.every((r) => r.ok),
				maxLoad1: Math.max(...rs.map((r) => r.load1))
			});
		}
	return { baseMs, cells };
};

const freePorts = async (count: number) => {
	const servers = [];
	const ports: number[] = [];
	for (let i = 0; i < count; i++) {
		const s = createServer();
		await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
		ports.push((s.address() as { port: number }).port);
		servers.push(s);
	}
	await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
	return ports;
};

const get = (port: number, n: number) =>
	new Promise<string>((resolveBody, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path: `/?n=${n}`,
				agent: false,
				headers: { connection: 'close' }
			},
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (body += c));
				res.on('end', () =>
					res.statusCode === 200
						? resolveBody(body)
						: reject(new Error(`status ${res.statusCode}`))
				);
			}
		);
		req.on('error', reject);
		req.end();
	});

const waitReady = async (port: number) => {
	const until = Date.now() + 20_000;
	for (;;) {
		try {
			await get(port, 0);
			return;
		} catch (err) {
			if (Date.now() > until) throw err;
			await new Promise((ok) => setTimeout(ok, 100));
		}
	}
};

const stop = (child: ChildProcess) =>
	new Promise<void>((ok) => {
		if (child.exitCode !== null) return ok();
		const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
		child.once('exit', () => {
			clearTimeout(timer);
			ok();
		});
		child.kill('SIGTERM');
	});

const main = async () => {
	const root = resolve(import.meta.dirname, '../..');
	const outDir = resolve(
		process.argv[2] ?? resolve(root, 'results/20261022-workerd-concurrency')
	);
	const rounds = Number(process.argv[3] ?? 20);
	const bin = resolve(root, 'node_modules/workerd/bin/workerd');
	for (const sub of ['configs', 'logs']) mkdirSync(resolve(outDir, sub), { recursive: true });

	const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
	const ports = await freePorts(10);
	const offset: Record<Arm, number> = { a: 0, b: 1, c: 2, d: 6 };
	const plans = Object.fromEntries(
		arms.map((arm) => [arm, planArm(arm, ports.slice(offset[arm]))])
	) as Record<Arm, Plan>;
	const children: { name: string; pid: number | undefined; child: ChildProcess }[] = [];
	const rows: Row[] = [];
	try {
		for (const arm of arms)
			for (const proc of plans[arm].processes) {
				const configPath = resolve(outDir, 'configs', `${proc.name}.capnp`);
				writeFileSync(configPath, proc.config);
				const log = openSync(resolve(outDir, 'logs', `${proc.name}.log`), 'w');
				const child = spawn(bin, ['serve', configPath], { stdio: ['ignore', log, log] });
				children.push({ name: proc.name, pid: child.pid, child });
				for (const p of proc.ports) await waitReady(p);
			}
		const pids = children.map((c) => ({ name: c.name, pid: c.pid }));

		const expectedCache = new Map<number, string>();
		const expect = (n: number) => {
			if (!expectedCache.has(n)) expectedCache.set(n, String(spin(n)));
			return expectedCache.get(n)!;
		};
		const n0 = 10_000_000;
		const calib: number[] = [];
		for (let i = 0; i < 7; i++) {
			const t = performance.now();
			const body = await get(at(plans.a.targets, 0), n0);
			const ms = performance.now() - t;
			if (body !== expect(n0)) throw new Error('calibration body mismatch');
			if (i >= 2) calib.push(ms);
		}
		const n = calibrateN(calib, n0);
		writeFileSync(
			resolve(outDir, 'calibration.json'),
			JSON.stringify({ n0, samplesMs: calib, n, targetMs: 100 }, null, '\t') + '\n'
		);
		const expected = expect(n);

		const cursor: Record<Arm, number> = { a: 0, b: 0, c: 0, d: 0 };
		const burst = async (arm: Arm, k: number, round: number): Promise<Row> => {
			const targets = plans[arm].targets;
			const load1 = at(loadavg(), 0);
			const t0 = performance.now();
			const replies = await Promise.all(
				Array.from({ length: k }, () => {
					const port = at(targets, cursor[arm]++ % targets.length);
					return get(port, n).then((body) => ({
						ms: performance.now() - t0,
						ok: body === expected
					}));
				})
			);
			return {
				arm,
				k,
				round,
				warmup: round === 0,
				wallMs: performance.now() - t0,
				latenciesMs: replies.map((r) => r.ms),
				ok: replies.every((r) => r.ok),
				load1
			};
		};

		const samplesPath = resolve(outDir, 'samples.jsonl');
		writeFileSync(samplesPath, '');
		for (let round = 0; round <= rounds; round++) {
			const order = arms.map((_, i) => at(arms, (i + round) % arms.length));
			for (const arm of order)
				for (const k of ks) {
					const row = await burst(arm, k, round);
					rows.push(row);
					appendFileSync(samplesPath, JSON.stringify(row) + '\n');
				}
		}

		const summary = {
			machine: {
				platform: platform(),
				arch: arch(),
				cpus: cpus().length,
				model: cpus()[0]?.model
			},
			workerd: version,
			n,
			rounds,
			warmupRounds: 1,
			pids,
			table: analyze(rows)
		};
		writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, '\t') + '\n');
		for (const c of summary.table.cells)
			console.log(
				`${c.arm} k=${String(c.k).padStart(2)} n=${c.n} median=${c.medianWallMs.toFixed(1)}ms ` +
					`min=${c.minWallMs.toFixed(1)} max=${c.maxWallMs.toFixed(1)} p95=${c.p95WallMs.toFixed(1)} ` +
					`speedup=${c.speedup.toFixed(2)} self=${c.selfSpeedup?.toFixed(2)} spread=${c.spreadPct.toFixed(1)}% ok=${c.ok}`
			);
	} finally {
		await Promise.all(children.map((c) => stop(c.child)));
	}
};

if (import.meta.main) await main();
