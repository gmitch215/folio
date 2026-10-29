import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { digest, researchEnvironment } from './environment.ts';

const calls = 64;

const addresses = (fraction: number) =>
	Array.from({ length: calls }, (_, index) =>
		index < Math.round(fraction * calls) ? 1024 : 1024 + (index + 1) * 4
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
	const widths = [2, 4, 8];
	const fractions = [0, 1 / 4];
	const intensities = [1024, 65536];
	emit(
		researchEnvironment({
			pairs,
			warmup: 2,
			calls,
			fractions,
			rounds: intensities,
			widths,
			boundary: 'runAll over the same call list with forced speculation',
			synthetic: true,
			verificationIncluded: false
		})
	);
	const source = new Uint8Array(readFileSync('build/fixture.wasm'));
	// identical instructions and memory size; only the import's shared flag differs
	const parsed = binaryen.readBinary(source),
		text = parsed.emitText();
	parsed.dispose();
	const unshared = binaryen.parseText(
		text.replace(/\(memory (\$[^ ]+ )?(\d+) (\d+) shared\)/, '(memory $1$2 $3)')
	);
	const unsharedBytes = unshared.emitBinary();
	unshared.dispose();

	const shared = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	const copied = new WebAssembly.Memory({ initial: 2, maximum: 8192 });
	const native = new WebAssembly.Instance(new WebAssembly.Module(source), {
		env: { memory: shared }
	});
	const pools: Folio[] = [];
	const arms: { name: string; memory: WebAssembly.Memory; width: number; pool?: Folio }[] = [
		{ name: 'native', memory: shared, width: 1 }
	];
	try {
		for (const width of widths) {
			const sharedPool = await Folio.open(source, {
				memory: shared,
				workers: width,
				profile: true
			});
			const copiedPool = await Folio.open(prepare(unsharedBytes, { minimumRegionWork: 0 }), {
				memory: copied,
				workers: width,
				minimumParallelWork: 0,
				profile: true
			});
			pools.push(sharedPool, copiedPool);
			arms.push(
				{ name: `shared-${width}`, memory: shared, width, pool: sharedPool },
				{ name: `copied-${width}`, memory: copied, width, pool: copiedPool }
			);
		}
		for (const rounds of intensities)
			for (const fraction of fractions) {
				const list = addresses(fraction).map((address) => ({
					export: 'mix',
					args: [address, rounds]
				}));
				initialize(shared);
				for (const call of list)
					(native.exports.mix as CallableFunction)(call.args[0], call.args[1]);
				const expected = new Uint8Array(shared.buffer).slice(),
					expectedSha256 = digest(expected);
				for (let round = -2; round < pairs; round++)
					for (let turn = 0; turn < arms.length; turn++) {
						const arm = arms[(turn + round + 2) % arms.length]!;
						initialize(arm.memory);
						const load = loadavg(),
							cpu = process.cpuUsage(),
							start = performance.now();
						let report: unknown;
						if (arm.pool)
							report = await arm.pool.runAll(list, { parallel: 'speculate' });
						else
							for (const call of list)
								(native.exports.mix as CallableFunction)(
									call.args[0],
									call.args[1]
								);
						const wallMs = performance.now() - start,
							used = process.cpuUsage(cpu);
						assert.ok(
							Buffer.from(arm.memory.buffer).equals(Buffer.from(expected)),
							`mix ${rounds} ${fraction} ${arm.name}`
						);
						if (round >= 0)
							emit({
								kind: 'sample',
								study: 'backing',
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
		for (const pool of pools) await pool.close();
	}
	emit({ kind: 'closed', complete: true });
}
