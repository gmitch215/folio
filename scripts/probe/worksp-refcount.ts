import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openContexts } from './php-contexts.ts';
import { instrumentWorksp, phpExtents } from './worksp-instrument.ts';

// verifies the refcount tags by a counter: a script that adds N references to one value must show
// exactly N more increments (and later N more decrements) at one address, from the tagged sites
// usage: node scripts/probe/worksp-refcount.ts OUTPUT.json
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: worksp-refcount.ts OUTPUT.json');
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const original = readFileSync(resolve(consumer, '.interp/php8.5.tuned.wasm'));
const extents = phpExtents(original);
const instrumented = instrumentWorksp(original, { mode: 'trace', ...extents });
const module = new WebAssembly.Module(instrumented.bytes);
const stackLow = extents.stackHigh - 32 * 1024 * 1024;
const layout = {
	stack: [stackLow, extents.stackHigh] as [number, number],
	static: [1024, stackLow] as [number, number]
};

const kinds: Record<string, (n: number) => string> = {
	string: (n) =>
		`<?php $s=str_repeat('x',100);$r=[];for($i=0;$i<${n};$i++){$r[]=$s;}echo strlen($s);`,
	array: (n) =>
		`<?php $s=array_fill(0,10,1);$r=[];for($i=0;$i<${n};$i++){$r[]=$s;}echo count($s);`,
	object: (n) => `<?php $s=new stdClass;$r=[];for($i=0;$i<${n};$i++){$r[]=$s;}echo get_class($s);`
};

async function hits(code: string) {
	const c = await openContexts({
		count: 1,
		kind: 'plain',
		mode: 'native',
		module,
		worksp: {
			mode: 'trace',
			sites: instrumented.sites,
			layout,
			verify: true,
			meta: {
				module: { name: 'php8.5.tuned.wasm', sha256: '' },
				machine: { name: 'verify', node: process.version }
			}
		},
		heapMb: 4096,
		bundle,
		consumer
	});
	try {
		const run = await c.worksp(0, {
			code,
			input: { id: 'rc' },
			options: { sensitivity: false }
		});
		return run.traced.rcHits as [number, number][];
	} finally {
		await c.close();
	}
}

let lastTop: unknown;
const side = (site: number) => (instrumented.sites.meta[site]! >> 5) & 3;
const report: Record<string, unknown> = {};
const verified = new Set<number>();
for (const [kind, code] of Object.entries(kinds)) {
	const big = 1000;
	const small = 100;
	const per = async (n: number) => {
		const rows = await hits(code(n));
		const byAddress = new Map<number, { site: number; count: number }[]>();
		for (const [key, count] of rows) {
			const site = key % 2 ** 21;
			const address = Math.floor(key / 2 ** 21);
			(byAddress.get(address) ?? byAddress.set(address, []).get(address)!).push({
				site,
				count
			});
		}
		lastTop = [...byAddress]
			.map(([address, list]) => ({
				address,
				total: list.reduce((t, r) => t + r.count, 0),
				sites: list.map((r) => `${r.site}:${side(r.site)}:${r.count}`).join(' ')
			}))
			.sort((x, y) => y.total - x.total)
			.slice(0, 5);
		let best:
			| { address: number; inc: number; dec: number; rows: { site: number; count: number }[] }
			| undefined;
		for (const [address, list] of byAddress) {
			const inc = list.filter((r) => side(r.site) === 1).reduce((s, r) => s + r.count, 0);
			const dec = list.filter((r) => side(r.site) === 2).reduce((s, r) => s + r.count, 0);
			if (inc >= n && (!best || inc > best.inc)) best = { address, inc, dec, rows: list };
		}
		return best;
	};
	const a = await per(big);
	const b = await per(small);
	if (!a || !b) {
		report[kind] = { ok: false, reason: 'no address with enough increments', top: lastTop };
		continue;
	}
	const delta = (side_: number) => {
		const sites = new Set(
			[...a.rows, ...b.rows].filter((r) => side(r.site) === side_).map((r) => r.site)
		);
		const rows = [...sites].map((site) => ({
			site,
			delta:
				(a.rows.find((r) => r.site === site)?.count ?? 0) -
				(b.rows.find((r) => r.site === site)?.count ?? 0)
		}));
		return { rows, total: rows.reduce((s, r) => s + r.delta, 0) };
	};
	const inc = delta(1);
	const dec = delta(2);
	const ok = inc.total === big - small && dec.total === big - small;
	if (ok) for (const r of [...inc.rows, ...dec.rows]) if (r.delta > 0) verified.add(r.site);
	report[kind] = {
		ok,
		references: { big, small },
		incrementDelta: inc.total,
		decrementDelta: dec.total,
		incrementSites: inc.rows.filter((r) => r.delta !== 0),
		decrementSites: dec.rows.filter((r) => r.delta !== 0),
		totalIncrementsAtAddress: { big: a.inc, small: b.inc }
	};
}
const patternSites = [...instrumented.sites.meta].filter((meta) => (meta >> 5) & 3).length;
writeFileSync(
	output,
	JSON.stringify(
		{
			module: 'php8.5.tuned.wasm',
			patternSites,
			patternStoreSitesInstrumented: {
				inc: instrumented.stats.rcInc,
				dec: instrumented.stats.rcDec
			},
			verifiedSites: verified.size,
			sites: [...verified].sort((x, y) => x - y),
			kinds: report
		},
		null,
		1
	) + '\n'
);
console.log(
	JSON.stringify({ verified: verified.size, patternSites, report }, null, 1).slice(0, 3000)
);
