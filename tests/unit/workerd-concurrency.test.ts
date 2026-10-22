import { expect, test } from 'vitest';
import {
	analyze,
	calibrateN,
	ks,
	planArm,
	spin,
	workerSource,
	workerdConfig,
	type Row
} from '../../scripts/probe/workerd-concurrency.ts';

test('the worker loop is the same in the spin function and the worker source', () => {
	expect(spin(0)).toBe(1);
	expect(spin(1)).toBe(1015568748);
	expect(workerSource).toContain('x = (Math.imul(x, 1664525) + 1013904223) | 0;');
	expect(workerSource).not.toMatch(/setTimeout|performance|Date/);
});

test('the config names every service, binding and socket it declares', () => {
	const config = workerdConfig(
		[
			{ name: 'w0', source: 'x' },
			{ name: 'front', source: 'y', bindings: [['W0', 'w0']] }
		],
		[{ name: 'http', address: '127.0.0.1:20001', service: 'front' }]
	);
	expect(config).toContain('(name = "w0", worker = .w0)');
	expect(config).toContain('(name = "front", worker = .front)');
	expect(config).toContain('bindings = [(name = "W0", service = "w0")]');
	expect(config).toContain(
		'(name = "http", address = "127.0.0.1:20001", http = (), service = "front")'
	);
});

test('each arm plans the processes and client targets the design calls for', () => {
	const ports = [20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009, 20010];
	const a = planArm('a', ports.slice(0, 1));
	expect(a.processes.length).toBe(1);
	expect(a.targets).toEqual([20001]);

	const b = planArm('b', ports.slice(1, 2));
	expect(b.processes.length).toBe(1);
	expect(b.processes[0]?.config).toContain('service = "front"');
	expect(b.processes[0]?.config.match(/worker = \./g)?.length).toBe(5);

	const c = planArm('c', ports.slice(2, 6));
	expect(c.processes.length).toBe(1);
	expect(c.targets).toEqual([20003, 20004, 20005, 20006]);
	expect(c.processes[0]?.config.match(/http = \(\)/g)?.length).toBe(4);

	const d = planArm('d', ports.slice(6, 10));
	expect(d.processes.length).toBe(4);
	expect(d.targets).toEqual([20007, 20008, 20009, 20010]);
	expect(d.processes.every((p) => p.ports.length === 1)).toBe(true);
});

test('calibration scales the spin count to the target time', () => {
	expect(calibrateN([50, 50, 50], 1_000_000, 100)).toBe(2_000_000);
	expect(calibrateN([25, 75, 50], 1_000_000, 100)).toBe(2_000_000);
});

const row = (arm: Row['arm'], k: number, wallMs: number, extra: Partial<Row> = {}): Row => ({
	arm,
	k,
	round: 1,
	warmup: false,
	wallMs,
	latenciesMs: [wallMs],
	ok: true,
	load1: 1,
	...extra
});

test('analyze reports speedup against the arm a single request and drops warm-up rows', () => {
	const rows: Row[] = [];
	for (const k of ks) {
		rows.push(row('a', k, 100, { round: 1 }));
		rows.push(row('a', k, 100, { round: 2 }));
		rows.push(row('d', k, 100 * k, { round: 1 }));
		rows.push(row('d', k, 100 * k, { round: 2 }));
	}
	rows.push(row('a', 1, 9999, { round: 0, warmup: true }));

	const { baseMs, cells } = analyze(rows);
	expect(baseMs).toBe(100);

	const scales = cells.find((c) => c.arm === 'a' && c.k === 4);
	expect(scales?.n).toBe(2);
	expect(scales?.speedup).toBeCloseTo(4);
	expect(scales?.spreadPct).toBe(0);
	expect(scales?.selfSpeedup).toBeCloseTo(4);

	const serial = cells.find((c) => c.arm === 'd' && c.k === 4);
	expect(serial?.medianWallMs).toBe(400);
	expect(serial?.speedup).toBeCloseTo(1);
	expect(serial?.selfSpeedup).toBeCloseTo(1);
});

test('analyze fails loudly without the arm a single request rows', () => {
	expect(() => analyze([row('d', 2, 100)])).toThrow('no measured arm a k=1 rows');
});
