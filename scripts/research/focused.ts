import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { prepareContext, type PreparedContext } from '../../src/compiler.ts';
import { ordinary, tasks } from './corpus-mechanisms.ts';
import { kernelContext, type ResetMode } from './corpus-worker.ts';
import { corpusManifest } from './corpus.ts';
import { digest, researchEnvironment } from './environment.ts';

const kernels = ['aes-cbc-decrypt', 'sha256', 'lz4-compress', 'xxhash32'];
const policies: ResetMode[] = ['whole', 'pages', 'checkpoint'];
const kinds = { ordinary, tasks };
const jobs = 16;

type Arm = { kind: keyof typeof kinds; width: number; idle: boolean };
type Pool = Awaited<ReturnType<typeof tasks>>;
const open = (arm: Arm, module: WebAssembly.Module, mode: ResetMode, layout?: PreparedContext) =>
	kinds[arm.kind](module, arm.width, layout, mode);

/** Seeded Fisher-Yates so a session's arm order is reproducible from its label. */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
	let state = parseInt(digest(seed).slice(0, 8), 16) || 1;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
	const result = [...items];
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(next() * (index + 1));
		[result[index], result[other]] = [result[other]!, result[index]!];
	}
	return result;
}

/** Current frequency in MHz of every allowed CPU, read before a timed run; empty where the kernel does not expose it. */
function frequencies() {
	const list = existsSync('/proc/self/status')
		? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
		: undefined;
	const cpus = (list ?? '').split(',').flatMap((part) => {
		const [from, to = from] = part.split('-').map(Number);
		return from === undefined || Number.isNaN(from)
			? []
			: Array.from({ length: to! - from + 1 }, (_, index) => from + index);
	});
	return cpus.flatMap((cpu) => {
		const path = `/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`;
		return existsSync(path) ? [Math.round(Number(readFileSync(path, 'utf8')) / 1000)] : [];
	});
}

if (import.meta.main) {
	const [directory, pairsArg = '9', ...selected] = process.argv.slice(2);
	if (!directory) throw new Error('usage: focused.ts OUTPUT_DIRECTORY [PAIRS] [KERNEL...]');
	const session = process.env.FOLIO_FOCUSED_SESSION ?? '1';
	const pairs = Number(pairsArg);
	assert.ok(Number.isSafeInteger(pairs) && pairs > 0);
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	emit(
		researchEnvironment({
			session,
			pairs,
			jobs,
			kernels,
			policies,
			arms: 'one pool of the arm under test, plus idle pools of every other kind and width when idle',
			scope: 'explicit independent operations; not automatic extraction'
		})
	);
	const arms: Arm[] = (['ordinary', 'tasks'] as const).flatMap((kind) => [
		{ kind, width: 8, idle: false },
		{ kind, width: 8, idle: true },
		{ kind, width: 1, idle: false }
	]);
	for (const id of selected.length ? selected : kernels) {
		const kernel = corpusManifest.cases.find((item) => item.id === id)!;
		const bytes = new Uint8Array(
			readFileSync(`build/research/corpus/artifacts/${kernel.id}.wasm`)
		);
		for (const mode of policies) {
			const layout = mode === 'checkpoint' ? prepareContext(bytes) : undefined;
			const module = new WebAssembly.Module(Uint8Array.from(layout?.bytes ?? bytes));
			const serial = kernelContext(module, mode, layout);
			const comparable = (rows: { value: string; sha256: string }[]) =>
				rows.map(({ value, sha256 }) => ({ value, sha256 }));
			const run = (repeats: number, verify = false) =>
				Array.from({ length: jobs }, () => serial(repeats, verify));
			const expected = comparable(run(4));
			const verified = comparable(run(4, true));
			for (const arm of shuffled(arms, `${session}/${id}/${mode}`)) {
				const idle: Pool[] = [];
				if (arm.idle)
					for (const kind of ['ordinary', 'tasks'] as const)
						for (const width of [1, 2, 4, 8])
							if (kind !== arm.kind || width !== arm.width)
								idle.push(
									(await open(
										{ kind, width, idle: false },
										module,
										mode,
										layout
									)) as Pool
								);
				const pool = (await open(arm, module, mode, layout)) as Pool;
				const name = `${id}/${mode}/${arm.kind}-${arm.width}${arm.idle ? '-idle' : ''}`;
				const batch = Math.max(1, jobs / arm.width);
				try {
					for (let round = -2; round < pairs; round++) {
						const sample = async (label: 'native' | 'folio') => {
							const freqMhz = frequencies(),
								cpu = process.cpuUsage(),
								start = performance.now();
							const output =
								label === 'native' ? run(4) : await pool.run(jobs, 4, batch);
							const wallMs = performance.now() - start,
								used = process.cpuUsage(cpu);
							assert.deepEqual(comparable(output), expected);
							if (label === 'folio')
								assert.deepEqual(
									comparable(await pool.run(arm.width, 0, 1, true)),
									Array.from({ length: arm.width }, () => verified[0])
								);
							if (round >= 0)
								emit({
									kind: 'sample',
									case: name,
									arm: label,
									round,
									session,
									wallMs,
									cpuMs: (used.user + used.system) / 1000,
									freqMhz,
									load: loadavg(),
									idleWorkers: idle.length ? 30 - arm.width : 0,
									resetMode: mode,
									outputSha256: digest(JSON.stringify(verified)),
									passed: true
								});
						};
						// the serial control runs beside the pool in the same round, alternating who goes first
						if (round % 2) {
							await sample('folio');
							await sample('native');
						} else {
							await sample('native');
							await sample('folio');
						}
					}
				} finally {
					await pool.close();
					for (const other of idle) await other.close();
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			console.log(`${id}/${mode}`);
		}
	}
	emit({ kind: 'closed', complete: true });
}
