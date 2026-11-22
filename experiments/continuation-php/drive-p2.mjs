import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBuild } from './prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runs = join(here, 'runs');
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const node26 = '/opt/homebrew/opt/node/bin/node';
const wranglerJs = join(here, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

if (!process.version.startsWith('v26')) throw new Error(`Node 26 required, got ${process.version}`);
const { wasmSha, glueSha } = prepareBuild();
const work = readFileSync(join(here, 'workload.php'), 'utf8');
const reference = readFileSync(join(runs, 'P0-output.txt'), 'utf8');
const persist = join(runs, 'wrangler-state');
rmSync(persist, { recursive: true, force: true });
mkdirSync(persist, { recursive: true });

const checks = [];
const failures = [];
function check(label, ok) {
	checks.push({ label, ok: !!ok });
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
	if (!ok) failures.push(label);
}

// local workerd only; no deploy flag is passed
const child = spawn(
	node26,
	[wranglerJs, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist],
	{ cwd: here, stdio: ['ignore', 'pipe', 'pipe'] }
);
let logText = '';
const ready = new Promise((resolve, reject) => {
	const onData = (d) => {
		logText += d.toString();
		if (/Ready on|http:\/\/127\.0\.0\.1:/.test(logText)) resolve();
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	child.on('exit', (code) =>
		reject(new Error(`wrangler exited ${code}: ${logText.slice(-800)}`))
	);
	setTimeout(() => reject(new Error('wrangler did not become ready')), 120000);
});

try {
	await ready;
	const start = await fetch(`${BASE}/start`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ work })
	});
	check('P2 job accepted', start.ok);
	let status;
	const deadline = Date.now() + 25 * 60 * 1000;
	for (;;) {
		if (Date.now() > deadline) throw new Error('P2 did not finish within 25 minutes');
		status = await (await fetch(`${BASE}/status`)).json();
		if (status.done) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	const events = status.events;
	const last = events.at(-1);
	check('P2 output equals the P0 output', status.out === reference);
	check(
		'P2 stack pointer and limits equal their post-init values at every event',
		events.every((e) => e.stackOk)
	);
	check(
		'P2 each signal park has reason SIGNAL and each budget park has reason BUDGET',
		events.every((e) => e.status !== 'PARKED' || (e.reason === 'SIGNAL') === e.sigFirst)
	);
	const restored = events.filter((e) => e.restoredFrom !== null).map((e) => e.k);
	check(
		'P2 the cut at event 6 rolled back and the next event restored',
		events.some((e) => e.k === 6 && e.cut)
	);
	check(
		'P2 restores happened before events 3, 7 (drop and cut replay), 10 and 12',
		JSON.stringify(restored) === JSON.stringify([3, 7, 10, 12])
	);
	const regions = ['B-done', 'C-done'].map((m) => {
		const ev = events.find(
			(e) => e.refusals > 0 && e.status === 'PARKED' && e.markers.includes(m)
		);
		return { region: m, event: ev ? ev.k : null };
	});
	check(
		'P2 an event with refusals parked after the array_map region (B-done)',
		regions[0].event !== null
	);
	check(
		'P2 an event with refusals parked after the generator region (C-done)',
		regions[1].event !== null
	);
	const commits = events.filter((e) => e.commit).map((e) => e.commit);
	const ms = commits.map((c) => c.ms).sort((a, b) => a - b);
	const summary = {
		node: process.version,
		wasmSha256: wasmSha,
		glueSha256: glueSha,
		outputSha256: createHash('sha256').update(status.out).digest('hex'),
		events: events.length,
		commits: commits.length,
		restored,
		cutAt: events.filter((e) => e.cut).map((e) => e.k),
		parksByReason: {
			BUDGET: events.filter((e) => e.reason === 'BUDGET').length,
			SIGNAL: events.filter((e) => e.reason === 'SIGNAL').length
		},
		refusalsTotal: events.reduce((s, e) => s + e.refusals, 0),
		regions,
		commitMs: { median: ms[Math.floor(ms.length / 2)], min: ms[0], max: ms.at(-1) },
		rowsPerCommit: commits.map((c) => ({
			k: c.k,
			kind: c.kind,
			changed: c.changed,
			rows: c.rows
		})),
		lastEvent: last ? last.k : null,
		checks
	};
	writeFileSync(join(runs, 'P2.json'), JSON.stringify(summary, null, '\t') + '\n');
	writeFileSync(join(runs, 'P2-events.json'), JSON.stringify(events, null, '\t') + '\n');
	console.log(
		JSON.stringify({
			events: summary.events,
			commits: summary.commits,
			restored,
			cutAt: summary.cutAt
		})
	);
} finally {
	child.kill('SIGTERM');
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
