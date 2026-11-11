import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../../src/compiler.ts';
import { Folio } from '../../../src/node.ts';
import { CertificateCache, decide } from '../../../src/router.ts';

export const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const mulberry = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// the same seeded bootstrap of the median as interval() in router-ablation.ts
export function interval(values: number[]) {
	const next = mulberry(12345);
	const boots = Array.from({ length: 2000 }, () =>
		median(values.map(() => values[Math.floor(next() * values.length)]!))
	).sort((a, b) => a - b);
	return {
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
		lo: boots[Math.floor(0.025 * boots.length)]!,
		hi: boots[Math.floor(0.975 * boots.length) - 1]!,
		n: values.length
	};
}

// usage:
//   harness.ts run DIR OUT.jsonl [--apps a,b] [--rounds N] [--workers N] [--warm N]
//   harness.ts inspect DIR APP [--workers N]
//   harness.ts decide DIR APP
//   harness.ts summary OUT.jsonl
// DIR holds build/ (build.ts output) and input/ (the program inputs). One fresh process per arm and round.

const here = fileURLToPath(import.meta.url);
const BASE = 8 << 20;
const PAGE = 65536;
const MAX_PAGES = 16384;

interface Case {
	args: string[];
	inputs: string[];
	outputs: string[];
	outCap: number;
	heap: number;
}

export const cases: Record<string, Case> = {
	aobench: { args: ['ao'], inputs: [], outputs: ['ao.ppm'], outCap: 1 << 20, heap: 4 << 20 },
	sixpack: {
		args: ['6pack', '-2', 'input.txt', 'out.6pk'],
		inputs: ['input.txt'],
		outputs: ['out.6pk'],
		outCap: 96 << 20,
		heap: 4 << 20
	},
	llama2: {
		args: [
			'run',
			'stories15M.bin',
			'-t',
			'0',
			'-s',
			'1',
			'-n',
			'128',
			'-i',
			'Once upon a time'
		],
		inputs: ['stories15M.bin', 'tokenizer.bin'],
		outputs: [],
		outCap: PAGE,
		heap: 32 << 20
	}
};
export const ORDER = ['aobench', 'sixpack', 'llama2'];

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const align = (n: number) => (n + PAGE - 1) & ~(PAGE - 1);

interface Layout {
	argv: number;
	heap: number;
	inputs: { name: string; at: number; bytes: Uint8Array }[];
	out: number;
	pages: number;
}

function layout(dir: string, c: Case): Layout {
	let at = BASE + PAGE;
	const heap = at;
	at = align(at + c.heap);
	const inputs = c.inputs.map((name) => {
		const bytes = readFileSync(join(dir, 'input', name));
		const place = at;
		at = align(at + bytes.length);
		return { name, at: place, bytes };
	});
	const out = at;
	at = align(at + Math.max(1, c.outputs.length) * c.outCap);
	return { argv: BASE, heap, inputs, out, pages: at / PAGE + 1 };
}

type Exports = Record<string, (...a: number[]) => number>;

function putName(memory: WebAssembly.Memory, x: Exports, name: string) {
	const at = x.w4b_scratch!();
	const bytes = new TextEncoder().encode(name + '\0');
	new Uint8Array(memory.buffer).set(bytes, at);
}

function setup(memory: WebAssembly.Memory, x: Exports, c: Case, l: Layout) {
	const u8 = new Uint8Array(memory.buffer);
	for (const input of l.inputs) u8.set(input.bytes, input.at);
	x.w4b_init!(l.heap, c.heap, l.out, c.outCap, Math.max(1, c.outputs.length));
	for (const input of l.inputs) {
		putName(memory, x, input.name);
		x.w4b_add_input!(input.at, input.bytes.length);
	}
	x.w4b_reset!();
	let strings = l.argv + 4096;
	c.args.forEach((arg, i) => {
		const bytes = new TextEncoder().encode(arg + '\0');
		u8.set(bytes, strings);
		new DataView(memory.buffer).setUint32(l.argv + 4 * i, strings, true);
		strings += bytes.length;
	});
	return { argc: c.args.length, argv: l.argv };
}

function digest(memory: WebAssembly.Memory, x: Exports, c: Case): string {
	const parts: string[] = [];
	for (const name of ['<stdout>', ...c.outputs]) {
		putName(memory, x, name);
		const index = x.w4b_lookup!();
		if (index < 0) {
			parts.push(`${name}:missing`);
			continue;
		}
		const at = x.w4b_data!(index);
		const len = x.w4b_len!(index);
		const view = new Uint8Array(memory.buffer, at, len);
		parts.push(`${name}:${len}:${sha(Uint8Array.from(view))}`);
	}
	return sha(parts.join(';'));
}

function nativeDigest(c: Case, stdout: Uint8Array, files: string[]) {
	const parts = [`<stdout>:${stdout.length}:${sha(stdout)}`];
	c.outputs.forEach((out, i) => {
		const bytes = readFileSync(files[i]!);
		parts.push(`${out}:${bytes.length}:${sha(bytes)}`);
	});
	return sha(parts.join(';'));
}

const slim = (r: Record<string, any>) => ({
	mode: r.mode,
	extraction: r.extraction,
	workers: r.workers,
	regions: r.regions,
	replayed: r.replayed,
	fallbacks: r.fallbacks,
	reason: r.reason,
	iteration: r.iteration && {
		regions: r.iteration.regions,
		replayed: r.iteration.replayed,
		batches: r.iteration.batches,
		failedBatches: r.iteration.failedBatches,
		stopped: r.iteration.stopped,
		conflicts: r.iteration.conflicts,
		admission: r.iteration.admission
	}
});

const emit = (row: Record<string, unknown>) => console.log('ROW ' + JSON.stringify(row));

type Variant = 'shared' | 'plain';

// a plain module declares an unshared import; as in the `today` arm of router-ablation.ts, a shared
// memory goes only to a module whose iteration route is not refused, and a refused one runs unshared
const folioShared = (bytes: Uint8Array, variant: Variant) =>
	variant === 'shared' || prepare(bytes).iterationRoute?.eligible !== false;

const wasmPath = (dir: string, app: string, variant: Variant) =>
	join(dir, 'build', `${app}${variant === 'plain' ? '.plain' : ''}.wasm`);

interface ChildArgs {
	dir: string;
	variant: Variant;
	app: string;
	arm: 'native' | 'serial' | 'folio' | 'folio-force';
	round: number;
	workers: number;
	warm: number;
	expected?: string;
}

async function child(a: ChildArgs) {
	const c = cases[a.app]!;
	const base = { kind: 'sample', app: a.app, arm: a.arm, round: a.round };
	const loadStart = loadavg()[0];
	if (a.arm === 'native') {
		const exe = join(a.dir, 'build', `${a.app}.native`);
		const cwd = join(a.dir, 'input');
		// the native program writes real files; 6pack refuses to overwrite, so every run has its own names
		const native = (tag: string) => {
			const outs = c.outputs.map((name) =>
				a.app === 'aobench'
					? join(cwd, name)
					: join(a.dir, 'native-out', `${a.round}-${process.pid}-${tag}-${name}`)
			);
			const args = c.args
				.slice(1)
				.map((arg) => (c.outputs.includes(arg) ? outs[c.outputs.indexOf(arg)]! : arg));
			const t = performance.now();
			const r = spawnSync(exe, args, { cwd, maxBuffer: 1 << 28 });
			const ms = performance.now() - t;
			return { ms, r, outs };
		};
		const first = native('a');
		const second = native('b');
		const equal = nativeDigest(c, new Uint8Array(second.r.stdout), second.outs);
		emit({
			...base,
			wallMs: second.ms,
			firstRunMs: first.ms,
			digest: equal,
			load: [loadStart],
			status: second.r.status
		});
		return;
	}
	const bytes = readFileSync(wasmPath(a.dir, a.app, a.variant));
	const l = layout(a.dir, c);
	const memory = new WebAssembly.Memory({
		initial: l.pages,
		maximum: MAX_PAGES,
		shared: a.arm.startsWith('folio') ? folioShared(bytes, a.variant) : a.variant === 'shared'
	});
	let x: Exports;
	let run: () => Promise<Record<string, unknown>>;
	let close = async () => {};
	const opened = performance.now();
	let target: { argc: number; argv: number } | undefined;
	if (a.arm === 'serial') {
		const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
			env: { memory }
		});
		x = instance.exports as unknown as Exports;
		run = async () => {
			x.main!(target!.argc, target!.argv);
			return { route: 'serial' };
		};
	} else {
		const folio = await Folio.open(bytes, {
			memory,
			workers: a.workers,
			...(a.arm === 'folio-force' ? { minimumRegionWork: 0 } : {})
		});
		x = folio.exports as unknown as Exports;
		close = () => folio.close();
		run = async () => {
			const report = await folio.run('main', [target!.argc, target!.argv]);
			return { route: 'folio', report: slim(report as unknown as Record<string, any>) };
		};
	}
	try {
		target = setup(memory, x, c, l);
		const openMs = performance.now() - opened;
		let firstRunMs = 0;
		let firstReport: unknown;
		for (let i = 0; i < a.warm; i++) {
			x.w4b_reset!();
			const t = performance.now();
			const r = await run();
			if (i === 0) {
				firstRunMs = performance.now() - t;
				firstReport = r.report;
			}
		}
		x.w4b_reset!();
		const t = performance.now();
		const result = await run();
		const wallMs = performance.now() - t;
		const out = digest(memory, x, c);
		emit({
			...base,
			wallMs,
			firstRunMs,
			openMs,
			firstReport,
			...result,
			digest: out,
			passed: a.expected === undefined ? true : out === a.expected,
			load: [loadStart]
		});
	} finally {
		await close();
	}
}

const flag = (argv: string[], name: string) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};

function spawnChild(a: ChildArgs): Record<string, any> {
	const r = spawnSync(process.execPath, [here, 'child', JSON.stringify(a)], {
		encoding: 'utf8',
		maxBuffer: 1 << 26,
		timeout: 1_800_000
	});
	const line = r.stdout.split('\n').find((l) => l.startsWith('ROW '));
	if (!line)
		return {
			kind: 'error',
			app: a.app,
			arm: a.arm,
			round: a.round,
			status: r.status,
			signal: r.signal,
			stderr: r.stderr.slice(-800)
		};
	return JSON.parse(line.slice(4));
}

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	if (command === 'child') return child(JSON.parse(rest[0]!));
	if (command === 'reasons') {
		for (const file of rest) {
			const plan = prepare(readFileSync(file));
			console.log(
				JSON.stringify({
					file,
					reasons: [...new Set(plan.reasons)],
					controlReasons: plan.controlReasons,
					iteration: plan.iterationRoute?.eligible
				})
			);
		}
		return;
	}
	if (command === 'dump') {
		const [dir, app, file] = rest as [string, string, string];
		const c = cases[app]!;
		const l = layout(dir, c);
		const variant = (flag(rest, '--variant') ?? 'plain') as Variant;
		const memory = new WebAssembly.Memory({
			initial: l.pages,
			maximum: MAX_PAGES,
			shared: variant === 'shared'
		});
		const bytes = readFileSync(wasmPath(dir, app, variant));
		const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } })
			.exports as unknown as Exports;
		const target = setup(memory, x, c, l);
		x.main!(target.argc, target.argv);
		putName(memory, x, '<stdout>');
		const index = x.w4b_lookup!();
		writeFileSync(file, new Uint8Array(memory.buffer, x.w4b_data!(index), x.w4b_len!(index)));
		return;
	}
	if (command === 'inspect') {
		const [dir, app] = rest as [string, string];
		const bytes = readFileSync(
			wasmPath(dir, app, (flag(rest, '--variant') ?? 'plain') as Variant)
		);
		const plan = prepare(bytes);
		console.log(
			JSON.stringify(
				{
					reasons: plan.reasons,
					loops: Object.keys(plan.loops),
					loopReasons: plan.loopReasons,
					controlReasons: plan.controlReasons,
					control: plan.control ? Object.keys(plan.control) : null,
					iterationRoute: plan.iterationRoute
						? {
								eligible: plan.iterationRoute.eligible,
								diagnostics: plan.iterationRoute.diagnostics
							}
						: null
				},
				null,
				2
			)
		);
		const c = cases[app]!;
		const l = layout(dir, c);
		const memory = new WebAssembly.Memory({
			initial: l.pages,
			maximum: MAX_PAGES,
			shared: folioShared(bytes, (flag(rest, '--variant') ?? 'plain') as Variant)
		});
		const folio = await Folio.open(bytes, {
			memory,
			workers: Number(flag(rest, '--workers') ?? 8)
		});
		try {
			console.log(
				JSON.stringify(
					{ diagnostics: folio.diagnostics, inspect: folio.inspect('main') },
					null,
					2
				)
			);
		} finally {
			await folio.close();
		}
		return;
	}
	if (command === 'decide') {
		const [dir, app] = rest as [string, string];
		const bytes = readFileSync(
			wasmPath(dir, app, (flag(rest, '--variant') ?? 'plain') as Variant)
		);
		for (const mode of ['independent', 'router'] as const) {
			const t = performance.now();
			const plan = decide(
				bytes,
				{
					kind: 'records',
					entry: 'main',
					count: 1,
					args: () => [0, 0],
					regions: [],
					writes: []
				},
				{ mode, pages: 256, workers: 8, cache: new CertificateCache() }
			);
			console.log(
				JSON.stringify({
					app,
					mode,
					ms: performance.now() - t,
					route: plan.decision.route,
					reason: plan.decision.reason,
					detail: plan.decision.detail.slice(0, 400),
					considered: plan.decision.considered.map((k) => ({
						route: k.route,
						verdict: k.verdict,
						reason: k.reason,
						detail: k.detail.slice(0, 300)
					}))
				})
			);
		}
		return;
	}
	if (command === 'summary') {
		const rows = readFileSync(rest[0]!, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		for (const app of ORDER) {
			const mine = rows.filter((r) => r.app === app && r.kind === 'sample' && r.round >= 0);
			if (!mine.length) continue;
			console.log(`## ${app}`);
			const by = (arm: string) => mine.filter((r) => r.arm === arm);
			const serial = by('serial');
			for (const arm of ['native', 'serial', 'folio', 'folio-force']) {
				const m = by(arm);
				if (!m.length) continue;
				const ratios = m.flatMap((r) => {
					const p = serial.find((s) => s.round === r.round);
					return p ? [p.wallMs / r.wallMs] : [];
				});
				const iv = ratios.length ? interval(ratios) : undefined;
				console.log(
					`${arm.padEnd(7)} n=${m.length} median ${median(m.map((r) => r.wallMs)).toFixed(1)} ms  speedup over serial ${iv ? `${iv.median.toFixed(3)} (min ${iv.min.toFixed(3)} max ${iv.max.toFixed(3)} ci ${iv.lo.toFixed(3)} to ${iv.hi.toFixed(3)})` : '-'}  wrong ${m.filter((r) => r.passed === false).length}  routes ${[...new Set(m.map((r) => r.report?.mode ?? r.route ?? '-'))].join(',')}`
				);
			}
		}
		const errors = rows.filter((r) => r.kind === 'error');
		console.log(`errors: ${errors.length}`);
		return;
	}
	if (command !== 'run') throw new Error(`unknown command ${command}`);
	const [dir, output] = rest as [string, string];
	const rounds = Number(flag(rest, '--rounds') ?? 7);
	const workers = Number(flag(rest, '--workers') ?? 8);
	const warm = Number(flag(rest, '--warm') ?? 2);
	const apps = flag(rest, '--apps')?.split(',') ?? ORDER;
	const variant = (flag(rest, '--variant') ?? 'plain') as Variant;
	const arms = (flag(rest, '--arms')?.split(',') ?? [
		'native',
		'serial',
		'folio'
	]) as ChildArgs['arm'][];
	if (!existsSync(output)) writeFileSync(output, '');
	const expected = new Map<string, string>();
	for (const app of apps) {
		const row = spawnChild({ dir, variant, app, arm: 'serial', round: -1, workers, warm: 0 });
		appendFileSync(output, JSON.stringify(row) + '\n');
		if (row.kind !== 'sample')
			throw new Error(`serial reference failed for ${app}: ${row.stderr}`);
		expected.set(app, row.digest);
	}
	for (let round = 0; round < rounds; round++)
		for (const [index, app] of apps.entries()) {
			const turn = (round + index) % arms.length;
			for (const arm of [...arms.slice(turn), ...arms.slice(0, turn)]) {
				const row = spawnChild({
					dir,
					variant,
					app,
					arm,
					round,
					workers,
					warm,
					expected: expected.get(app)
				});
				appendFileSync(output, JSON.stringify(row) + '\n');
				if (row.passed === false)
					console.error(`WRONG OUTPUT ${app} ${arm} round ${round}`);
			}
		}
	console.log('done', output);
}

if (import.meta.main) await main(process.argv.slice(2));
