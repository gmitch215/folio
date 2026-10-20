import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

type Raw = Record<string, any>;

export interface CollectOptions {
	cpu?: boolean;
	count?: number;
	rounds?: number;
	nonce?: string;
	fetch?: (url: URL, init?: RequestInit) => Promise<Response>;
}

export function summarize(raw: Raw) {
	const { capabilities, rpc, cpu } = raw;
	assert.ok(capabilities.isolateId);
	assert.equal(rpc.bytes.ok, true, JSON.stringify(rpc.bytes));
	assert.equal(rpc.bytes.value.remoteBefore, 17);
	assert.equal(rpc.bytes.value.remoteAfter, 29);
	assert.equal(rpc.bytes.value.echoedAfter, 29);
	assert.equal(rpc.bytes.value.callerUnaffected, true);
	const summary: Raw = {
		ordinaryByteRpcExact: true,
		rpcDistinctIsolates: rpc.distinctIsolates,
		localSabCloneAlias:
			capabilities.cloneSab.ok &&
			capabilities.cloneSab.value.forwardVisible &&
			capabilities.cloneSab.value.reverseVisible,
		localChannelSabAlias:
			capabilities.localChannelSab.ok && capabilities.localChannelSab.value.sourceSeesWrite,
		bundledAtomicExact:
			capabilities.bundledWasmAtomics.ok && capabilities.bundledWasmAtomics.value.valid,
		sharedRpc: Object.fromEntries(
			[
				'sab',
				'sharedMemory',
				'ordinaryMemory',
				'returnSab',
				'returnSharedMemory',
				'rpcMessagePort'
			].map((name) => [name, rpc[name]])
		),
		invocationsUpperBound: 57
	};
	if (!cpu) return summary;
	assert.equal(cpu.laneInvocations, 45);
	assert.equal(cpu.rows.length, 12);
	assert.equal(cpu.exact, true);
	for (const row of cpu.rows) {
		assert.equal(row.parts.length, row.lanes);
		assert.equal(row.exact, true);
		assert.equal(row.checksum, cpu.expected);
		assert.equal(
			row.parts.reduce((sum: number, part: Raw) => sum + part.count, 0),
			cpu.count
		);
		for (let i = 0; i < row.parts.length; i++) {
			assert.equal(row.parts[i].start, Math.floor((cpu.count * i) / row.lanes));
			assert.equal(
				row.parts[i].count,
				Math.floor((cpu.count * (i + 1)) / row.lanes) - row.parts[i].start
			);
		}
	}
	summary.cpu = [1, 2, 4, 8].map((lanes) => {
		const rows = cpu.rows.filter((row: Raw) => row.lanes === lanes && row.phase === 'measure');
		const walls: number[] = rows
			.map((row: Raw) => row.wallMs)
			.sort((a: number, b: number) => a - b);
		const baseline = cpu.rows.filter((row: Raw) => row.lanes === 1 && row.phase === 'measure');
		return {
			lanes,
			n: rows.length,
			medianWallMs: (walls[0]! + walls[1]!) / 2,
			minWallMs: walls[0],
			maxWallMs: walls[1],
			pairedSpeedups: rows.map((row: Raw) =>
				row.wallMs > 0
					? baseline.find((base: Raw) => base.round === row.round).wallMs / row.wallMs
					: null
			),
			distinctIsolates: rows.map((row: Raw) => row.distinctIsolates)
		};
	});
	const byIsolate = new Map<string, Raw[]>();
	for (const part of cpu.rows.flatMap((row: Raw) => row.parts)) {
		byIsolate.set(part.isolateId, [...(byIsolate.get(part.isolateId) ?? []), part]);
	}
	summary.coResidentObjects = [...byIsolate].flatMap(([id, parts]) => {
		const objects = [...new Set(parts.map((part) => part.objectId))];
		return objects.length > 1 ? [{ isolateId: id, objectIds: objects }] : [];
	});
	return summary;
}

export async function collect(origin: string, options: CollectOptions = {}) {
	const nonce = options.nonce ?? `folio-${crypto.randomUUID()}`;
	const request = options.fetch ?? ((url: URL, init?: RequestInit) => fetch(url, init));
	const raw: Raw = { collectedAt: new Date().toISOString(), origin, nonce };
	const read = async (path: string, body?: unknown) => {
		const response = await request(
			new URL(path, origin),
			body
				? {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(30000)
					}
				: { signal: AbortSignal.timeout(30000) }
		);
		const value = await response.json();
		if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
		return value;
	};
	raw.capabilities = await read('/capabilities');
	raw.rpc = await read('/rpc', { nonce });
	if (options.cpu !== false) {
		raw.cpu = await read('/cpu', {
			nonce,
			count: options.count ?? 524288,
			rounds: options.rounds ?? 128
		});
	}
	return { raw, summary: summarize(raw) };
}

if (import.meta.main) {
	const [origin, output] = process.argv.slice(2);
	if (!origin || !output) throw new Error('Usage: node experiments/cloud/run.ts URL OUTPUT.json');
	const result = await collect(origin);
	await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
	console.log(JSON.stringify(result.summary, null, 2));
}
