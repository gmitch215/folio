import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { Folio } from '../../dist/node.js';

assert.equal(process.platform, 'linux', 'affinity probe requires Linux procfs');
const mask = '4-11';
const cores = Array.from({ length: 8 }, (_, index) => index + 4);
const clockTicksPerSecond = Number(
	execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()
);
assert.ok(Number.isSafeInteger(clockTicksPerSecond) && clockTicksPerSecond > 0);
const coreCounterFields = [
	'user',
	'nice',
	'system',
	'idle',
	'iowait',
	'irq',
	'softirq',
	'steal',
	'guest',
	'guest_nice'
];
function coreCounters() {
	const counters = readFileSync('/proc/stat', 'utf8')
		.split('\n')
		.map((line) => /^(cpu\d+)\s+(.+)$/.exec(line))
		.filter(Boolean)
		.filter((match) => cores.includes(Number(match[1].slice(3))))
		.map((match) => {
			const ticks = match[2].trim().split(/\s+/).map(Number);
			assert.ok(ticks.length >= 8 && ticks.every(Number.isSafeInteger));
			return { cpu: Number(match[1].slice(3)), ticks };
		});
	assert.equal(counters.length, cores.length);
	return counters;
}
const topology = cores.map((cpu) => ({
	cpu,
	core: readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`, 'utf8').trim(),
	package: readFileSync(
		`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`,
		'utf8'
	).trim()
}));
assert.equal(new Set(topology.map((cpu) => `${cpu.package}:${cpu.core}`)).size, 8);
const tids = () => new Set(readdirSync('/proc/self/task').filter((name) => /^\d+$/.test(name)));
function thread(tid) {
	assert.match(String(tid), /^\d+$/);
	const status = readFileSync(`/proc/${tid}/status`, 'utf8');
	assert.equal(
		Number(/^Tgid:\s+(\d+)$/m.exec(status)?.[1]),
		process.pid,
		`refusing affinity change for a thread outside process ${process.pid}`
	);
	return {
		tid: Number(tid),
		comm: readFileSync(`/proc/${tid}/comm`, 'utf8').trim(),
		affinity: /^Cpus_allowed_list:\s+(.+)$/m.exec(status)?.[1]?.trim()
	};
}
function setAffinity(threads, pinned) {
	return threads.map((entry, index) => {
		thread(entry.tid);
		const allowed = pinned ? String(cores[index]) : mask;
		execFileSync('taskset', ['-pc', allowed, String(entry.tid)], { encoding: 'utf8' });
		const actual = thread(entry.tid);
		assert.equal(actual.affinity, allowed);
		return actual;
	});
}

const program = JSON.parse(
	readFileSync(new URL('../../build/control-prepared.json', import.meta.url)),
	(_, value) =>
		value?.folioBytes ? Uint8Array.from(Buffer.from(value.folioBytes, 'base64')) : value
);
const pages = Number(process.env.FOLIO_PAGES ?? 4097);
const count = Number(process.env.FOLIO_COUNT ?? 64);
const rounds = Number(process.env.FOLIO_ROUNDS ?? 2097152);
const repeats = Number(process.env.FOLIO_REPEATS ?? 7);
assert.ok(
	[pages, count, rounds, repeats].every((value) => Number.isSafeInteger(value) && value > 0)
);
const makeMemory = () => new WebAssembly.Memory({ initial: pages, maximum: 8192, shared: true });
const oracleMemory = makeMemory();
const oracle = new WebAssembly.Instance(new WebAssembly.Module(program.original), {
	env: { memory: oracleMemory }
});
const pools = [];
const discovered = [];
const arms = [
	{
		name: 'raw',
		workers: 0,
		memory: oracleMemory,
		threads: [],
		pinned: false,
		invoke: () => oracle.exports.main(1024, count, rounds)
	}
];
const initialize = (memory) => {
	new Uint8Array(memory.buffer).fill(0);
	const view = new Uint32Array(memory.buffer, 1024, count);
	for (let i = 0; i < count; i++) view[i] = Math.imul(i + 1, 2654435761) >>> 0;
};

try {
	for (const width of [1, 2, 4, 8]) {
		const memory = makeMemory();
		const before = tids();
		const pool = await Folio.open(program, { memory, workers: width, profile: true });
		pools.push(pool);
		const after = tids();
		const threads = [...after].filter((tid) => !before.has(tid)).map(thread);
		assert.equal(
			threads.length,
			width === 1 ? 0 : width,
			JSON.stringify({ width, unexpectedNewThreads: threads })
		);
		assert.equal(pool.threadIds.length, width === 1 ? 0 : width);
		setAffinity(threads, false);
		discovered.push({ width, threads: threads.map((entry) => thread(entry.tid)) });
		const base = {
			workers: width,
			memory,
			threads,
			invoke: () => pool.run('main', [1024, count, rounds])
		};
		if (width === 1) arms.push({ ...base, name: 'auto-1', pinned: false });
		else
			for (const pinned of [false, true])
				arms.push({
					...base,
					name: `auto-${width}-${pinned ? 'pinned' : 'unpinned'}`,
					pinned
				});
	}
	initialize(oracleMemory);
	const expectedValue = oracle.exports.main(1024, count, rounds);
	const expected = Uint8Array.from(new Uint8Array(oracleMemory.buffer));
	console.log(
		JSON.stringify({
			metadata: {
				node: process.version,
				v8: process.versions.v8,
				model: cpus()[0].model,
				pid: process.pid,
				sourceSha256: createHash('sha256').update(program.original).digest('hex'),
				pages,
				count,
				rounds,
				repeats,
				warmups: 2,
				checkedBytes: expected.length,
				mask,
				topology,
				discovered,
				arms: arms.map((arm) => arm.name),
				clockTicksPerSecond,
				coreCounterFields,
				comparison:
					'same Folio pool per width; own worker TIDs pinned or restored before timing',
				processCpuCounter:
					'one process.cpuUsage delta per invocation, outside affinity commands',
				batchLimit: '16 regions per worker',
				flags: 'see scripts/build/fixtures.ts'
			}
		})
	);
	for (let iteration = -2; iteration < repeats; iteration++) {
		const shift = (iteration + 2) % arms.length;
		const order = [...arms.slice(shift), ...arms.slice(0, shift)];
		for (const arm of order) {
			const affinity = setAffinity(arm.threads, arm.pinned);
			initialize(arm.memory);
			const load = loadavg();
			const coreBefore = coreCounters();
			const cpuStart = process.cpuUsage();
			const started = performance.now();
			const result = await arm.invoke();
			const wallMs = performance.now() - started;
			const cpu = process.cpuUsage(cpuStart);
			const coreAfter = coreCounters();
			const value = arm.name === 'raw' ? result : result.values[0];
			assert.equal(value, expectedValue);
			assert.deepEqual(new Uint8Array(arm.memory.buffer), expected);
			if (arm.workers > 1) {
				assert.equal(result.extraction, 'control-flow');
				assert.equal(result.workers, arm.workers);
				assert.equal(result.regions, count);
				assert.equal(result.replayed, 0);
				assert.equal(result.fallbacks, 0);
			}
			console.log(
				JSON.stringify({
					iteration,
					arm: arm.name,
					wallMs,
					cpuMs: (cpu.user + cpu.system) / 1000,
					affinity,
					load,
					coreCounters: { before: coreBefore, after: coreAfter },
					freeMiB: freemem() / 1048576,
					rssMiB: process.memoryUsage().rss / 1048576,
					exact: true,
					...(arm.name === 'raw' ? {} : { report: result })
				})
			);
		}
	}
} finally {
	await Promise.all(pools.map((pool) => pool.close()));
}
