import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name}`);
	return value;
}

const WORKER = required('WORKER_URL');
const OBJECTS = Number(process.env.OBJECTS ?? 10);
const OUT = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const RUN = Date.now();
const Z = 1.959964;

interface Stat {
	inst: string;
	started: number;
	done: number;
	instancesSeen: number;
	alarmStarts: number;
	lastAt: number | null;
}

interface Reply {
	ok: boolean;
	body?: Partial<Stat> & { started?: boolean };
	error?: string;
}

interface Row {
	name: string;
	stat: Stat | null;
	error: string | null;
	startedWithoutDone: number | null;
	instanceChanges: number | null;
	instanceChangesPerFire: number | null;
}

async function call(name: string, op?: string): Promise<Reply> {
	const url = new URL(WORKER);
	url.searchParams.set('do', name);
	if (op) url.searchParams.set('op', op);
	return (await (await fetch(url)).json()) as Reply;
}

function names(): string[] {
	return Array.from({ length: OBJECTS }, (_, i) => `idle-${i}`);
}

async function start(): Promise<void> {
	for (const name of names()) {
		await call(name);
		const reply = await call(name, 'start');
		console.log(
			name,
			reply.ok ? `chain ${reply.body?.started ? 'started' : 'already on'}` : reply.error
		);
	}
}

function wilsonUpper(failed: number, n: number): number | null {
	if (n === 0) return null;
	const p = failed / n;
	const z2 = Z * Z;
	const centre = p + z2 / (2 * n);
	const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return (centre + margin) / (1 + z2 / n);
}

async function stat(): Promise<void> {
	const rows: Row[] = [];
	for (const name of names()) {
		const reply = await call(name, 'stat');
		const body = reply.ok ? (reply.body as Stat) : null;
		rows.push({
			name,
			stat: body,
			error: reply.ok ? null : (reply.error ?? 'unknown'),
			startedWithoutDone: body ? body.started - body.done : null,
			instanceChanges: body ? Math.max(0, body.instancesSeen - 1) : null,
			instanceChangesPerFire:
				body && body.started > 0 ? Math.max(0, body.instancesSeen - 1) / body.started : null
		});
	}
	const ok = rows.filter((r) => r.stat);
	const fires = ok.reduce((n, r) => n + (r.stat?.started ?? 0), 0);
	const completed = ok.reduce((n, r) => n + (r.stat?.done ?? 0), 0);
	const failed = fires - completed;
	const totals = {
		objects: rows.length,
		objectsReporting: ok.length,
		fires,
		completed,
		failed,
		startsMinusCounter: ok.reduce(
			(n, r) => n + ((r.stat?.started ?? 0) - (r.stat?.alarmStarts ?? 0)),
			0
		),
		instanceChanges: ok.reduce((n, r) => n + (r.instanceChanges ?? 0), 0),
		wilsonUpper95: wilsonUpper(failed, fires)
	};
	console.table(
		rows.map((r) => ({
			name: r.name,
			started: r.stat?.started ?? r.error,
			done: r.stat?.done,
			failed: r.startedWithoutDone,
			alarmStarts: r.stat?.alarmStarts,
			instancesSeen: r.stat?.instancesSeen,
			lastAt: r.stat?.lastAt
		}))
	);
	console.log(totals);
	mkdirSync(OUT, { recursive: true });
	const file = `${OUT}/idle-${RUN}.json`;
	writeFileSync(file, JSON.stringify({ at: new Date(RUN).toISOString(), rows, totals }, null, 1));
	console.log(file);
}

const cmd = process.argv[2];
if (cmd === 'start') await start();
else if (cmd === 'stat') await stat();
else throw new Error('usage: idle.ts start | stat');
