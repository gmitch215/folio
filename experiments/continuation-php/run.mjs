import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from './lib.mjs';
import { prepareBuild } from './prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runs = join(here, 'runs');
const arm = process.argv[2];
if (arm !== 'P0' && arm !== 'P1') throw new Error('usage: node run.mjs <P0|P1>');
if (!process.version.startsWith('v26')) throw new Error(`Node 26 required, got ${process.version}`);
mkdirSync(runs, { recursive: true });

const { build, wasmSha, glueSha } = prepareBuild();
globalThis.location ??= new URL(pathToFileURL(process.cwd() + '/').href);
globalThis.self ??= globalThis;
const module = await WebAssembly.compile(readFileSync(join(build, 'php8.5-worker.mjs.wasm')));
const factory = (await import(pathToFileURL(join(build, 'php8.5-worker.mjs')).href)).default;
const work = readFileSync(join(here, 'workload.php'), 'utf8');

const checks = [];
const failures = [];
function check(label, ok) {
	checks.push({ label, ok: !!ok });
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
	if (!ok) failures.push(label);
}
const load = () => execFileSync('uptime', [], { encoding: 'utf8' }).trim();
const header = {
	node: process.version,
	wasmSha256: wasmSha,
	glueSha256: glueSha,
	loadBefore: load()
};

// unparked reference: no arm, no signal
async function p0() {
	const p = await L.boot(factory, module);
	await L.initPhp(p, work);
	L.arm(p, 0);
	const t0 = performance.now();
	const res = await L.run(p, work);
	const ms = performance.now() - t0;
	check('P0 ran without a PHP error', res.ret === 0);
	check('P0 output ends with the checksum line', /\d+:\d+:[0-9a-f]{32}:\d+\n$/.test(res.text));
	writeFileSync(join(runs, 'P0-output.txt'), res.text);
	return { text: res.text, ms, memBytes: p.memory.buffer.byteLength };
}

// the event protocol in full: drops before events 3, 7, 12, signals before 5 and 9, a drop after the
// signal park of event 9 so event 10 replays from the commit after event 8
async function p1(reference) {
	const store = new MemoryStore();
	const proto = new L.Protocol({ factory, module, work, sched: L.SCHEDULE, store });
	const t0 = performance.now();
	let failure = null;
	try {
		while (!proto.s.done) {
			if (proto.s.k >= 4000) throw new Error('event limit reached');
			await proto.event();
		}
	} catch (e) {
		failure = `${e.name}: ${e.message}`;
	}
	const events = store.events;
	const wall = performance.now() - t0;
	check('P1 every restore passes the MEMFS, stack and tempRet0 checks', failure === null);
	if (failure) console.log(`restore or event failure: ${failure}`);
	check('P1 output equals the P0 output', proto.s.done && proto.s.out === reference.text);
	check(
		'P1 stack pointer and limits equal their post-init values at every event',
		events.every((e) => e.stackOk)
	);
	check(
		'P1 each signal park has reason SIGNAL and each budget park has reason BUDGET',
		events.every((e) => e.status !== 'PARKED' || (e.reason === 'SIGNAL') === e.sigFirst)
	);
	const restored = events.filter((e) => e.restoredFrom !== null).map((e) => e.k);
	check(
		'P1 restores happened before events 3, 7, 10 (replay) and 12',
		JSON.stringify(restored) === JSON.stringify([3, 7, 10, 12])
	);
	const regions = ['B-done', 'C-done'].map((m) => {
		const ev = events.find(
			(e) => e.refusals > 0 && e.status === 'PARKED' && e.markers.includes(m)
		);
		return { region: m, event: ev ? ev.k : null };
	});
	check(
		'P1 an event with refusals parked after the array_map region (B-done)',
		regions[0].event !== null
	);
	check(
		'P1 an event with refusals parked after the generator region (C-done)',
		regions[1].event !== null
	);
	const commits = events.filter((e) => e.commit).map((e) => e.commit);
	const ms = commits.map((c) => c.ms).sort((a, b) => a - b);
	return {
		wall,
		events: events.length,
		commits: commits.length,
		restored,
		parksByReason: {
			BUDGET: events.filter((e) => e.reason === 'BUDGET').length,
			SIGNAL: events.filter((e) => e.reason === 'SIGNAL').length
		},
		refusalsTotal: events.reduce((s, e) => s + e.refusals, 0),
		regions,
		commitMs: { median: ms[Math.floor(ms.length / 2)], min: ms[0], max: ms.at(-1) },
		changedPerCommit: commits.map((c) => c.changed),
		memBytes: commits.at(-1)?.memBytes ?? 0,
		finalSha256: proto.s.done ? createHash('sha256').update(proto.s.out).digest('hex') : null,
		failure,
		eventLog: events
	};
}

// in-memory checkpoint store for the Node arm
class MemoryStore {
	constructor() {
		this.hashesArr = [];
		this.groups = [];
		this.man = null;
		this.events = [];
		this.state = null;
	}
	async hashes() {
		return this.hashesArr;
	}
	async write(cap, manifest) {
		let rows = 0;
		for (const gi of cap.changed) {
			this.groups[gi] = cap.copies.get(gi);
			this.hashesArr[gi] = cap.hashes[gi];
			rows++;
		}
		this.man = manifest;
		return { rows: rows + 1 };
	}
	async load() {
		return this.man ? { manifest: this.man, groups: this.groups } : null;
	}
	async appendEvent(rec) {
		this.events.push(rec);
	}
	async saveState(s) {
		this.state = { ...s, pending: '' };
	}
}

const summaryBase = (arm) => ({ ...header, arm });
const finish = (summary, name) => {
	writeFileSync(join(runs, `${name}.json`), JSON.stringify(summary, null, '\t') + '\n');
};

if (arm === 'P0') {
	const r = await p0();
	finish(
		{
			...summaryBase('P0'),
			ms: Math.round(r.ms),
			memBytes: r.memBytes,
			loadAfter: load(),
			checks
		},
		'P0'
	);
	console.log(JSON.stringify({ arm, ms: Math.round(r.ms), memBytes: r.memBytes }));
} else {
	const reference = { text: readFileSync(join(runs, 'P0-output.txt'), 'utf8') };
	const r = await p1(reference);
	const { eventLog, ...rest } = r;
	writeFileSync(join(runs, 'P1-events.json'), JSON.stringify(eventLog, null, '\t') + '\n');
	finish({ ...summaryBase('P1'), ...rest, loadAfter: load(), checks }, 'P1');
	console.log(JSON.stringify(rest));
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
