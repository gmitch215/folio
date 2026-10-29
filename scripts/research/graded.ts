import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Folio } from '../../src/node.ts';
import { digest, researchEnvironment } from './environment.ts';

const calls = 64;
const hot = 1024;

export const addresses = (fraction: number) =>
	Array.from({ length: calls }, (_, index) =>
		index < Math.round(fraction * calls) ? hot : hot + (index + 1) * 4
	);

function initialize(memory: WebAssembly.Memory) {
	new Uint8Array(memory.buffer).fill(0);
	const words = new Uint32Array(memory.buffer, 1024, 1024);
	for (let index = 0; index < words.length; index++)
		words[index] = Math.imul(index + 1, 2654435761) >>> 0;
}

if (import.meta.main) {
	const [directory, pairsArg = '9'] = process.argv.slice(2),
		pairs = Number(pairsArg);
	assert.ok(directory && Number.isSafeInteger(pairs) && pairs > 0);
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	const fractions = [0, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1];
	const intensities = [16, 1024, 65536];
	const widths = [2, 4, 8];
	emit(
		researchEnvironment({
			pairs,
			warmup: 2,
			calls,
			fractions,
			rounds: intensities,
			widths,
			routingCalls: 40,
			synthetic: true,
			verificationIncluded: false
		})
	);
	const source = new Uint8Array(readFileSync('build/fixture.wasm'));
	const module = new WebAssembly.Module(source);

	// graded conflicts: a fraction of the calls updates one shared word
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	const native = new WebAssembly.Instance(module, { env: { memory } });
	const pools = new Map<number, Folio>();
	for (const width of widths)
		pools.set(width, await Folio.open(source, { memory, workers: width, profile: true }));
	try {
		for (const rounds of intensities)
			for (const fraction of fractions) {
				const list = addresses(fraction).map((address) => ({
					export: 'mix',
					args: [address, rounds]
				}));
				initialize(memory);
				for (const call of list)
					(native.exports.mix as CallableFunction)(call.args[0], call.args[1]);
				const expected = new Uint8Array(memory.buffer).slice(),
					expectedSha256 = digest(expected);
				const arms = [
					{
						name: 'native',
						run: async () => {
							for (const call of list)
								(native.exports.mix as CallableFunction)(
									call.args[0],
									call.args[1]
								);
						}
					},
					...widths.map((width) => ({
						name: `forced-${width}`,
						run: () => pools.get(width)!.runAll(list, { parallel: 'speculate' })
					})),
					{ name: 'auto-8', run: () => pools.get(8)!.runAll(list) }
				];
				for (let round = -2; round < pairs; round++)
					for (let turn = 0; turn < arms.length; turn++) {
						const arm = arms[(turn + round + 2) % arms.length]!;
						initialize(memory);
						const load = loadavg(),
							cpu = process.cpuUsage(),
							start = performance.now(),
							report = await arm.run();
						const wallMs = performance.now() - start,
							used = process.cpuUsage(cpu);
						assert.ok(
							Buffer.from(memory.buffer).equals(Buffer.from(expected)),
							`mix ${rounds} ${fraction} ${arm.name}`
						);
						if (round >= 0)
							emit({
								kind: 'sample',
								study: 'graded',
								cell: { rounds, fraction, calls },
								arm: arm.name,
								round,
								wallMs,
								cpuMs: (used.user + used.system) / 1000,
								load,
								report,
								passed: true,
								verifiedBytes: expected.length,
								outputSha256: expectedSha256
							});
					}
				console.log(JSON.stringify({ rounds, fraction }));
			}
	} finally {
		for (const pool of pools.values()) await pool.close();
	}

	// routing: repeated calls of conflicting entries with and without adaptive routing
	const cells = [
		{ entry: 'aliased_program', args: [1024, 64, 4096] },
		{ entry: 'dependent_program', args: [1024, 64] }
	];
	const sequence = 40;
	for (const cell of cells) {
		const arms = [] as {
			name: string;
			memory: WebAssembly.Memory;
			run: () => Promise<unknown>;
			close: () => Promise<void>;
		}[];
		const own = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
		const instance = new WebAssembly.Instance(module, { env: { memory: own } });
		arms.push({
			name: 'native',
			memory: own,
			run: async () => (instance.exports[cell.entry] as CallableFunction)(...cell.args),
			close: async () => {}
		});
		for (const adaptiveRouting of [false, true]) {
			const target = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
			const pool = await Folio.open(source, {
				memory: target,
				workers: 8,
				profile: true,
				adaptiveRouting
			});
			arms.push({
				name: adaptiveRouting ? 'adaptive-8' : 'default-8',
				memory: target,
				run: () => pool.run(cell.entry, cell.args),
				close: () => pool.close()
			});
		}
		initialize(own);
		await arms[0]!.run();
		const expected = new Uint8Array(own.buffer).slice(),
			expectedSha256 = digest(expected);
		try {
			for (let round = 0; round < pairs; round++)
				for (let call = 0; call < sequence; call++)
					for (let turn = 0; turn < arms.length; turn++) {
						const arm = arms[(turn + round) % arms.length]!;
						initialize(arm.memory);
						const load = loadavg(),
							cpu = process.cpuUsage(),
							start = performance.now(),
							report = (await arm.run()) as
								{ mode?: string; reason?: string } | undefined;
						const wallMs = performance.now() - start,
							used = process.cpuUsage(cpu);
						assert.ok(
							Buffer.from(arm.memory.buffer).equals(Buffer.from(expected)),
							`${cell.entry} ${arm.name}`
						);
						emit({
							kind: 'sample',
							study: 'routing',
							cell,
							arm: arm.name,
							round,
							call,
							wallMs,
							cpuMs: (used.user + used.system) / 1000,
							load,
							mode: report?.mode,
							reason: report?.reason,
							report,
							passed: true,
							outputSha256: expectedSha256
						});
					}
			console.log(JSON.stringify(cell));
		} finally {
			for (const arm of arms) await arm.close();
		}
	}
	emit({ kind: 'closed', complete: true });
}
