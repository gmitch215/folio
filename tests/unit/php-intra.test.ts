import { receiveMessageOnPort } from 'node:worker_threads';
import { expect, test } from 'vitest';
import {
	summarizeIndirect,
	summarizeIntra,
	summarizeSnapshot
} from '../../scripts/analyze/intra.ts';
import { ownerBridge, serveTasks } from '../../scripts/probe/php-task-bridge.ts';
import { requestCode, workloads } from '../../scripts/probe/php-tasks.ts';
import { createTaskLinks } from '../../src/tasks.ts';

const intraRow = (arm: string, round: number, requestMs: number, extra: object = {}) => ({
	kind: 'sample',
	name: 'w',
	size: { n: 1 },
	arm,
	round,
	requestMs,
	ownerCpuMs: arm === 'plain' ? requestMs : 1,
	processCpuMs: requestMs * (arm === 'plain' ? 1 : 1.1),
	serverCpuMs: arm === 'plain' ? [] : [requestMs, requestMs],
	taskMs: arm === 'plain' ? [] : [requestMs, requestMs],
	taskWorker: arm === 'plain' ? [] : [0, 1],
	overlapMs: arm === 'api-2' ? requestMs : 0,
	maxConcurrent: arm === 'api-2' ? 2 : arm === 'plain' ? 0 : 1,
	waitMs: 1,
	submitHostMs: 0.1,
	encodeMs: 0.2,
	decodeMs: 0.3,
	argBytes: 10,
	resultBytes: 20,
	sha256: 'same',
	load: [1, 1, 1],
	...extra
});

test('intra summary pairs each arm with the plain arm of its round and counts overlapped samples', () => {
	const rows: any[] = [{ kind: 'environment', boots: [{ openMs: 5 }], memoryBytes: [64] }];
	for (let round = 0; round < 3; round++) {
		rows.push(intraRow('plain', round, 100));
		rows.push(intraRow('api-1', round, 100));
		rows.push(intraRow('api-2', round, 50));
	}
	const summary: any = summarizeIntra(rows, 'h');
	const arms = summary.names.w.arms;
	expect(arms['api-2'].speedupOverPlain.median).toBe(2);
	expect(arms['api-2'].samplesWithOverlap).toBe(3);
	expect(arms['api-1'].samplesWithOverlap).toBe(0);
	expect(arms['api-2'].processCpuOverPlain.median).toBeCloseTo(0.55, 5);
	expect(arms.plain.speedupOverPlain.median).toBe(1);
});

test('intra summary refuses samples whose outputs differ from each other', () => {
	const rows: any[] = [
		{ kind: 'environment', boots: [{ openMs: 5 }], memoryBytes: [64] },
		intraRow('plain', 0, 10),
		intraRow('api-1', 0, 10, { sha256: 'other' })
	];
	expect(() => summarizeIntra(rows, 'h')).toThrow(/outputs differ/);
});

test('indirect summary weights sites by dynamic calls and labels targets by census class', () => {
	const rows: any[] = [
		{ kind: 'environment' },
		{
			kind: 'counts',
			label: 'run',
			sha256: ['a'],
			triples: [0, 10, 60, 1, 11, 20, 1, 12, 20],
			functions: {
				10: { name: 'f10', label: 'pure' },
				11: { name: 'f11', label: 'other node or global' },
				12: { name: 'f12', label: 'other node or global' }
			},
			siteFn: { 0: { fn: 'a', label: 'x' }, 1: { fn: 'b', label: 'y' } }
		}
	];
	const run: any = (summarizeIndirect(rows, 'h') as any).runs.run;
	expect(run.dynamicIndirectCalls).toBe(100);
	expect(run.shareAtSitesWithOneTarget).toBe(0.6);
	expect(run.shareAtSitesWithAtMost4Targets).toBe(1);
	expect(run.shareByTargetLabel.pure).toBe(0.6);
	expect(run.shareByTargetLabel['other node or global']).toBe(0.4);
	expect(run.topSites[0]).toMatchObject({ site: 0, distinctTargets: 1, topTargetShare: 1 });
});

test('snapshot summary counts correct clones and groups drupal outcomes', () => {
	const rows: any[] = [{ kind: 'environment' }];
	for (let i = 0; i < 4; i++)
		rows.push({
			kind: 'plain-sample',
			correct: i < 3,
			bytes: 64,
			copyMs: 10 + i,
			adoptMs: 1,
			firstRunMs: 0.5,
			load: [1, 1, 1]
		});
	rows.push({ kind: 'drupal-sample', outcome: 'TypeError: x\n at y', bytes: 90, copyMs: 5 });
	const summary: any = summarizeSnapshot(rows, 'h');
	expect(summary.plain.correctClones).toBe(3);
	expect(summary.drupal.outcomes).toEqual({ 'TypeError: x': 1 });
	expect(summary.drupal.rendered).toBe(0);
});

test('the job count changes the range and refuses a fixed job list', () => {
	const hash = workloads.find((w) => w.name === 'hash-batch')!;
	expect(requestCode(hash, { n: 7 }, 'plain')).toContain('range(0, 7)');
	expect(requestCode(hash, { n: 7 }, 'api', 48)).toContain('range(0, 47)');
	const mixed = workloads.find((w) => w.name === 'mixed')!;
	expect(() => requestCode(mixed, { n: 7 }, 'plain', 16)).toThrow(/fixed job list/);
	expect(requestCode(mixed, { n: 7 }, 'plain')).toContain('w_hash');
});

test('the request source differs only in how it runs the jobs', () => {
	const workload = workloads.find((w) => w.name === 'hash-batch')!;
	const plain = requestCode(workload, { n: 7 }, 'plain');
	const api = requestCode(workload, { n: 7 }, 'api');
	const inline = requestCode(workload, { n: 7 }, 'inline');
	expect(plain).toContain('["w_hash", [$i, 7]]');
	expect(plain).not.toContain('task_submit');
	expect(api).toContain("$GLOBALS['__t_inline_mode']=false");
	expect(inline).toContain("$GLOBALS['__t_inline_mode']=true");
	expect(plain.endsWith('echo md5(serialize($out));')).toBe(true);
	expect(api.endsWith('echo md5(serialize($out));')).toBe(true);
});

test('the owner bridge spreads tasks round robin over the width and logs each join', () => {
	const links = createTaskLinks(2);
	const owner = ownerBridge(links.owner);
	const ids = ['a', 'b', 'c'].map((fn) => owner.submit(JSON.stringify({ fn, b64: 'QQ==' })));
	expect(ids).toEqual(['0:0', '1:1', '0:2']);
	for (const [k, id] of ids.entries()) {
		const server = links.server[k % 2]!;
		const request: any = receiveMessageOnPort(server.port)!.message;
		expect(request).toMatchObject({ id, name: 'abc'[k], input: 'QQ==' });
		server.port.postMessage({
			id,
			ok: true,
			output: new TextEncoder().encode('Ug=='),
			startMs: 1,
			endMs: 3,
			cpuMs: 2
		});
		Atomics.add(new Int32Array(server.signal), 0, 1);
	}
	expect(JSON.parse(owner.join('1:1'))).toEqual({ ok: true, b64: 'Ug==' });
	expect(JSON.parse(owner.join('0:0'))).toEqual({ ok: true, b64: 'Ug==' });
	const log = owner.drain();
	expect(log.map((t) => t.id)).toEqual(['1:1', '0:0']);
	expect(log[0]).toMatchObject({ worker: 1, fn: 'b', argBytes: 4, resultBytes: 4, cpuMs: 2 });
	owner.setWidth(1);
	expect(owner.submit(JSON.stringify({ fn: 'x', b64: '' }))).toBe('0:3');
	expect(owner.submit(JSON.stringify({ fn: 'y', b64: '' }))).toBe('0:4');
	for (const link of [...links.owner, ...links.server]) link.port.close();
});

test('a task server runs tasks in order, replies with timing and wakes the owner', async () => {
	const links = createTaskLinks(1);
	const code: string[] = [];
	let tick = 0;
	serveTasks(
		links.server[0]!,
		async (source) => {
			code.push(source);
			return source.includes('"boom"') ? Promise.reject(new Error('bad')) : 'T0s=';
		},
		() => (tick += 5)
	);
	const replies: any[] = [];
	const done = new Promise<void>((resolve) => {
		links.owner[0]!.port.on('message', (m) => {
			replies.push(m);
			if (replies.length === 2) resolve();
		});
	});
	links.owner[0]!.port.postMessage({ id: '0:0', name: 'w_hash', input: 'QQ==', submitMs: 0 });
	links.owner[0]!.port.postMessage({ id: '0:1', name: 'boom', input: 'QQ==', submitMs: 0 });
	await done;
	expect(code[0]).toBe(`<?php echo __cfw_task_exec("w_hash", 'QQ==');`);
	expect(replies[0]).toMatchObject({ id: '0:0', ok: true, cpuMs: 5 });
	expect(new TextDecoder().decode(replies[0].output)).toBe('T0s=');
	expect(replies[1]).toMatchObject({ id: '0:1', ok: false });
	expect(Atomics.load(new Int32Array(links.server[0]!.signal), 0)).toBe(2);
	links.owner[0]!.port.close();
});
