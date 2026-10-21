import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { sha256 } from './lib.ts';

// usage: node scripts/analyze/profile.ts PROFILE.cpuprofile[.gz] MODULE.wasm OUTPUT.json [CENSUS.json]
// attributes V8 CPU profile samples to exported wasm functions; unexported ones keep their index
export function exportNames(wasm: Uint8Array) {
	let cursor = 8;
	const uint = () => {
		let result = 0,
			shift = 0,
			byte: number;
		do {
			byte = wasm[cursor++]!;
			result += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return result;
	};
	const names = new Map<number, string>();
	while (cursor < wasm.length) {
		const id = wasm[cursor++]!;
		const end = uint() + cursor;
		if (id === 7) {
			for (let i = uint(); i > 0; i--) {
				const length = uint();
				const name = new TextDecoder().decode(wasm.subarray(cursor, cursor + length));
				cursor += length;
				const kind = wasm[cursor++];
				const index = uint();
				if (kind === 0 && !names.has(index)) names.set(index, name);
			}
		}
		cursor = end;
	}
	return names;
}

export interface Labels {
	importedFunctions: number;
	labels: string[];
	functionLabels: Record<string, number>;
}

export function summarizeProfile(raw: Uint8Array, wasm: Uint8Array, census?: Labels) {
	const names = exportNames(wasm);
	const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
	const profile = JSON.parse(Buffer.from(text).toString());
	const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node]));
	const wasmSelf = new Map<string, number>();
	const byLabel = new Map<string, number>();
	let total = 0;
	let wasmTotal = 0;
	profile.samples.forEach((id: number, i: number) => {
		const delta: number = profile.timeDeltas[i];
		total += delta;
		const match = /^wasm-function\[(\d+)\]$/.exec(nodes.get(id).callFrame.functionName);
		const named =
			!match &&
			names.size &&
			[...names.values()].includes(nodes.get(id).callFrame.functionName);
		if (!match && !named) return;
		const name = match
			? (names.get(Number(match[1])) ?? `index ${match[1]}`)
			: nodes.get(id).callFrame.functionName;
		wasmSelf.set(name, (wasmSelf.get(name) ?? 0) + delta);
		wasmTotal += delta;
		if (census && match) {
			const label =
				census.labels[
					census.functionLabels[String(Number(match[1]) - census.importedFunctions)] ?? -1
				] ?? 'unclassified';
			byLabel.set(label, (byLabel.get(label) ?? 0) + delta);
		}
	});
	const rows = [...wasmSelf].sort((a, b) => b[1] - a[1]);
	let covered = 0;
	let half = 0;
	for (const [, time] of rows) {
		if (covered >= wasmTotal / 2) break;
		covered += time;
		half++;
	}
	const ms = (value: number) => Math.round(value / 100) / 10;
	return {
		sampledMs: ms(total),
		wasmMs: ms(wasmTotal),
		wasmFunctionsSampled: rows.length,
		functionsCoveringHalfOfWasmTime: half,
		unexportedWasmMs: ms(
			rows.filter(([name]) => name.startsWith('index ')).reduce((s, r) => s + r[1], 0)
		),
		...(census
			? {
					shareOfWasmByBlockingRule: Object.fromEntries(
						[...byLabel]
							.sort((a, b) => b[1] - a[1])
							.map(([label, time]) => [
								label,
								Math.round((1000 * time) / wasmTotal) / 1000
							])
					)
				}
			: {}),
		top: rows.slice(0, 20).map(([name, time]) => ({
			name,
			selfMs: ms(time),
			shareOfWasm: Math.round((1000 * time) / wasmTotal) / 1000
		}))
	};
}

if (import.meta.main) {
	const [profilePath, wasmPath, output, censusPath] = process.argv.slice(2);
	if (!profilePath || !wasmPath || !output)
		throw new Error('usage: profile.ts PROFILE.cpuprofile[.gz] MODULE.wasm OUTPUT.json');
	const raw = readFileSync(profilePath);
	const wasm = readFileSync(wasmPath);
	const summary = {
		profileSha256: sha256(raw),
		moduleSha256: sha256(wasm),
		...summarizeProfile(
			raw,
			wasm,
			censusPath ? JSON.parse(readFileSync(censusPath, 'utf8')) : undefined
		)
	};
	writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
	console.log(JSON.stringify({ ...summary, top: summary.top.slice(0, 5) }));
}
