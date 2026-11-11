import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { certifyOwnership, guardRecords } from '../../src/ownership.ts';
import { hostMath, moduleBytes, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, outDir, specs } from './c21-kernels.ts';

// usage: ownership-drivers.ts [id ...] ; certify the fixed-address and allocator drivers
const ids = process.argv.slice(2);
const DRIVERS = ids.length
	? ids
	: [
			'sha256-shared',
			'aes-cbc-decrypt-shared',
			'jsmn-parse-shared',
			'kissfft-real-shared',
			'miniz-compress',
			'miniz-decompress',
			'qoi-encode',
			'qoi-decode',
			'brotli-compress',
			'qoa-encode',
			'yyjson-read',
			'md4c-html',
			'sha256',
			'aes-cbc-decrypt'
		];

// the shared write set of the first records, as the footprint probe finds it, as byte ranges
function probe(id: string) {
	const spec = specs.find((s) => s.id === id)!;
	const n = Math.min(6, spec.n);
	const records = recordsOf(spec, n);
	const layout = layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const pages = layout.pages + 8;
	const bytes = moduleBytes(spec);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: { memory, ...hostMath() }
	}).exports as Record<string, Function>;
	if (spec.config) exports.setup!(layout.config, spec.config.perRecord ? n : 1, spec.config.nfft);
	writeRecords(memory, spec, layout, records);
	const view = new Uint8Array(memory.buffer);
	const baseline = view.slice();
	const count = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		view.set(baseline);
		exports.bulk!(layout.table + 16 * i, 1, layout.out + spec.slot * i);
		for (let at = 0; at < view.length; at++) {
			if (view[at] === baseline[at]) continue;
			const own =
				(at >= layout.out + spec.slot * i && at < layout.out + spec.slot * (i + 1)) ||
				(spec.arena > 0 &&
					at >= layout.arena + i * spec.arena &&
					at < layout.arena + (i + 1) * spec.arena);
			if (!own) count.set(at, (count.get(at) ?? 0) + 1);
		}
	}
	const shared = [...count]
		.filter(([, c]) => c > 1)
		.map(([at]) => at)
		.sort((a, b) => a - b);
	const ranges: { low: number; end: number }[] = [];
	for (const at of shared) {
		const top = ranges[ranges.length - 1];
		if (top && at <= top.end + 64) top.end = at + 1;
		else ranges.push({ low: at, end: at + 1 });
	}
	const regions: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		regions.push([layout.table + 16 * i, layout.table + 16 * i + 16]);
		regions.push([layout.out + spec.slot * i, layout.out + spec.slot * (i + 1)]);
		const word = (k: number) => new Uint32Array(memory.buffer, layout.table + 16 * i, 4)[k]!;
		if (word(0)) regions.push([word(0), word(0) + records[i]!.input.length]);
		if (word(2) && spec.config) regions.push([word(2), word(2) + spec.config.stride]);
		else if (word(2)) regions.push([word(2), word(2) + spec.auxBytes]);
		if (spec.arena) regions.push([word(3), word(3) + spec.arena]);
	}
	return { shared: shared.length, ranges, regions };
}

for (const id of DRIVERS) {
	const file = `${outDir}/${id}.wasm`;
	if (!existsSync(file)) {
		console.log(id, 'NOT BUILT');
		continue;
	}
	const bytes = new Uint8Array(readFileSync(file));
	const started = performance.now();
	const arenaBytes = specs.find((s) => s.id === id)?.arena;
	const allocator =
		process.env.ALLOC && arenaBytes
			? { allocator: { arenaBytes, assumeInArena: !!process.env.ASSUME } }
			: {};
	const result = certifyOwnership(bytes, {
		...allocator,
		...(process.env.PREFIX ? { prefix: true as const } : {})
	});
	const ms = Math.round(performance.now() - started);
	const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
	let line = `${id} ${sha} ${ms}ms: `;
	if (result.kind === 'certificate') {
		const size = result.windows.reduce((n, w) => n + w.end - w.low, 0);
		const written = result.written.reduce((n, r) => n + r[1] - r[0], 0);
		line += `CERTIFIED windows=${JSON.stringify(result.windows)} window_bytes=${size} written_bytes=${written} sites=${JSON.stringify(result.sites)} steps=${result.stats.steps}`;
	} else
		line += `REFUSED ${result.reason} (${result.obligation}) ${result.detail}${result.address === undefined ? '' : ' @' + result.address}`;
	console.log(line);
	if (!process.env.NO_PROBE) {
		try {
			const p = probe(id);
			const withProposal = certifyOwnership(bytes, { proposed: p.ranges });
			let extra = `  probe shared=${p.shared} ranges=${JSON.stringify(p.ranges.slice(0, 4))}${p.ranges.length > 4 ? '...' : ''} with proposal: `;
			if (withProposal.kind === 'certificate') {
				extra += `CERTIFIED guard=${guardRecords(withProposal, p.regions)}`;
			} else
				extra += `REFUSED ${withProposal.reason} ${withProposal.detail}${withProposal.address === undefined ? '' : ' @' + withProposal.address}`;
			if (p.ranges.length) {
				const ok =
					result.kind === 'certificate' ? guardRecords(result, p.regions) : undefined;
				extra += ` guard(derived)=${ok}`;
			}
			console.log(extra);
		} catch (error) {
			console.log('  probe failed', String(error).slice(0, 120));
		}
	}
}
