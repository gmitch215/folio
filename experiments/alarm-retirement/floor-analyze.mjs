import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

// usage: node floor-analyze.mjs <dir with trials.jsonl, chains.jsonl, tail.jsonl>
const dir = process.argv[2];
if (!dir) throw new Error('usage: floor-analyze.mjs <dir>');
const RESET = 'Internal error in Durable Object storage caused object to be reset';
const Z = 1.959964;

const readJsonl = (name) => {
	const path = `${dir}/${name}`;
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
};

const wilson = (k, n) => {
	if (n === 0) return [NaN, NaN];
	const p = k / n;
	const d = 1 + (Z * Z) / n;
	const c = (p + (Z * Z) / (2 * n)) / d;
	const h = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;

const lnFact = (n) => {
	let s = 0;
	for (let i = 2; i <= n; i++) s += Math.log(i);
	return s;
};
const logC = (n, k) => lnFact(n) - lnFact(k) - lnFact(n - k);
const hyper = (x, n1, K, N) => {
	if (x < 0 || x > K || n1 - x < 0 || n1 - x > N - K) return 0;
	return Math.exp(logC(K, x) + logC(N - K, n1 - x) - logC(N, n1));
};
// two-sided Fisher exact on [[a, b], [c, d]]
const fisher = (a, b, c, d) => {
	const n1 = a + b;
	const N = n1 + c + d;
	const K = a + c;
	const pObs = hyper(a, n1, K, N);
	let p = 0;
	for (let x = Math.max(0, K - (c + d)); x <= Math.min(n1, K); x++) {
		const px = hyper(x, n1, K, N);
		if (px <= pObs * (1 + 1e-7)) p += px;
	}
	return Math.min(1, p);
};

const matches = (s, kind, obj) => new RegExp(`(${kind}) ${obj}(?!\\d)`).test(s);
const tail = (existsSync(`${dir}/tail.jsonl`) ? readTail(`${dir}/tail.jsonl`) : []).map((r) => ({
	r,
	s: JSON.stringify(r)
}));
const tailFor = (obj, kinds) => tail.filter(({ s }) => matches(s, kinds, obj));
const tailMsgTs = (obj, kind) => {
	for (const { r } of tailFor(obj, kind)) {
		for (const log of r.logs ?? []) {
			if (JSON.stringify(log.message ?? '').includes(`${kind} ${obj}`))
				return log.timestamp ?? null;
		}
	}
	return null;
};

// fresh arm
const allTrials = readJsonl('trials.jsonl');
const trials = allTrials.filter((t) => t.cls !== 'code_update');
console.log(
	`code-updated trials excluded: ${allTrials.length - trials.length} of ${allTrials.length}`
);
const fresh = trials.map((t) => {
	const reqRecs = tailFor(t.object, 'req|entry-error');
	const alarmRecs = tailFor(t.object, 'alarm');
	const tailReset = [...reqRecs, ...alarmRecs].some(({ s }) => s.includes(RESET));
	const reqTs = tailMsgTs(t.object, 'req');
	const alarmTs = tailMsgTs(t.object, 'alarm');
	const alarmDelayMs = reqTs !== null && alarmTs !== null ? alarmTs - reqTs : null;
	return {
		...t,
		respReset: t.cls === 'storage_reset',
		tailReset,
		tailReqSeen: reqRecs.length > 0,
		tailAlarmSeen: alarmRecs.length > 0,
		anyReset: t.cls === 'storage_reset' || tailReset,
		alarmDelayMs,
		alarmInRequest:
			alarmDelayMs !== null && t.actualMs !== null ? alarmDelayMs < t.actualMs : null
	};
});

console.log(`## Fresh arm (trials: ${fresh.length}; tail records: ${tail.length})`);
console.log(
	'L F n respReset tailReset anyReset anyReset 95% margin(F-L) pred_margin pred_F<5 alarmInRequest(median ms) readCls'
);
const cells = {};
for (const t of fresh) {
	const key = `L${t.L}F${t.F}`;
	(cells[key] ??= { L: t.L, F: t.F, rows: [] }).rows.push(t);
}
const freshByKey = {};
for (const key of Object.keys(cells).sort()) {
	const { L, F, rows } = cells[key];
	const n = rows.length;
	const resets = rows.filter((r) => r.anyReset).length;
	const resp = rows.filter((r) => r.respReset).length;
	const tr = rows.filter((r) => r.tailReset).length;
	const [lo, hi] = wilson(resets, n);
	const margin = F - L;
	const predMargin = margin < 5 ? 'reset' : 'none';
	const predAlt = F < 5 ? 'reset' : 'none';
	const inReq = rows.filter((r) => r.alarmInRequest === true).length;
	const inReqKnown = rows.filter((r) => r.alarmInRequest !== null).length;
	const delays = rows
		.map((r) => r.alarmDelayMs)
		.filter((x) => x !== null)
		.sort((a, b) => a - b);
	const med = delays.length ? delays[Math.floor(delays.length / 2)] : 'n/a';
	const readCls = [...new Set(rows.map((r) => r.readCls))].join('/');
	freshByKey[key] = { L, F, n, resets, margin, predMargin, predAlt };
	console.log(
		`${L} ${F} ${n} ${resp} ${tr} ${resets} ${resets}/${n} [${pct(lo)}, ${pct(hi)}] ${margin} ${predMargin} ${predAlt} ${inReq}/${inReqKnown} (${med}) ${readCls}`
	);
}

console.log('\n## Fresh: Fisher exact (two-sided) against F = 15 at the same L');
for (const L of [2, 4, 8]) {
	const ref = freshByKey[`L${L}F15`];
	if (!ref) continue;
	for (const F of [1, 5, 10]) {
		const c = freshByKey[`L${L}F${F}`];
		if (!c) continue;
		const p = fisher(c.resets, c.n - c.resets, ref.resets, ref.n - ref.resets);
		console.log(
			`L=${L} F=${F} ${c.resets}/${c.n} vs F=15 ${ref.resets}/${ref.n}: p=${p.toFixed(4)}`
		);
	}
}

const scoreFresh = (rule) => {
	let agree = 0;
	for (const c of Object.values(freshByKey)) {
		const predicted = c[rule] === 'reset';
		const observed = c.resets / c.n >= 0.5;
		if (predicted === observed) agree++;
	}
	return `${agree}/${Object.keys(freshByKey).length}`;
};
console.log(
	`\nFresh cells agreeing (observed reset rate >= 50% vs prediction): margin rule ${scoreFresh('predMargin')}, F < 5 rule ${scoreFresh('predAlt')}`
);

// warm arm
const allChains = readJsonl('chains.jsonl');
const chains = allChains.filter((c) => !c.events.some((e) => e.cls === 'code_update'));
console.log(
	`code-updated chains excluded: ${allChains.length - chains.length} of ${allChains.length}`
);
const warm = {};
for (const ch of chains) {
	const key = `L${ch.L}F${ch.F}`;
	const w = (warm[key] ??= {
		L: ch.L,
		F: ch.F,
		chains: 0,
		chainsReset: 0,
		resets: 0,
		retirements: 0,
		tailChainsReset: 0,
		events: 0
	});
	w.chains++;
	const tailHit = tailFor(ch.object, 'req|entry-error|alarm').some(({ s }) => s.includes(RESET));
	if (tailHit) w.tailChainsReset++;
	let prevIso = null;
	let hadReset = false;
	for (const e of ch.events) {
		w.events++;
		if (e.cls === 'storage_reset') {
			w.resets++;
			hadReset = true;
		}
		if (e.ok) {
			if (prevIso !== null && e.iso !== prevIso) w.retirements++;
			prevIso = e.iso;
		}
	}
	if (hadReset) w.chainsReset++;
}
console.log(
	'\n## Warm arm (chains of 24 back-to-back events; retirement = ok event with a new isolate id)'
);
console.log(
	'L F margin(F-L) pred_margin chains chainsWithReset resets retirements resets/retirement tailChainsReset events'
);
for (const key of Object.keys(warm).sort()) {
	const w = warm[key];
	const margin = w.F - w.L;
	const ratio = w.retirements ? (w.resets / w.retirements).toFixed(2) : 'n/a';
	console.log(
		`${w.L} ${w.F} ${margin} ${margin < 5 ? 'reset' : 'none'} ${w.chains} ${w.chainsReset} ${w.resets} ${w.retirements} ${ratio} ${w.tailChainsReset} ${w.events}`
	);
}
