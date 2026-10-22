import { expect, test } from 'vitest';
import { parseDeployLog, summarizeSteps } from '../../experiments/bootimage/analyze.ts';
import { checkPages, pageBytes, pagesChecksum } from '../../experiments/bootimage/checksum.ts';
import { emptyMiB, requestBound, sequence } from '../../experiments/bootimage/plan.ts';
import { importModule, ownModule } from '../../experiments/bootimage/prepare.ts';

test('checksum covers every check page and its position', () => {
	const pages = Math.max(...checkPages) + 1;
	const base = new ArrayBuffer(pages * pageBytes);
	const same = pagesChecksum(base);
	expect(pagesChecksum(new ArrayBuffer(pages * pageBytes))).toBe(same);
	for (const page of checkPages) {
		const copy = new Uint8Array(new ArrayBuffer(pages * pageBytes));
		copy[page * pageBytes + pageBytes - 1] = 1;
		expect(pagesChecksum(copy.buffer)).not.toBe(same);
	}
	const untouched = new Uint8Array(new ArrayBuffer(pages * pageBytes));
	untouched[1 * pageBytes] = 1;
	expect(pagesChecksum(untouched.buffer)).toBe(same);
});

test('each variant sends 21 uniquely indexed Durable Object requests within the bound', () => {
	for (const variant of ['a', 'b', 'c'] as const) {
		const steps = sequence(variant);
		expect(steps).toHaveLength(21);
		expect(new Set(steps.map((step) => step.path)).size).toBe(21);
		expect(steps.filter((step) => step.path.includes('check=1'))).toHaveLength(3);
		const bound = requestBound(variant);
		expect(bound.maximumRequests).toBeLessThanOrEqual(25);
		expect(bound.maximumDurableObjectRequests).toBeLessThanOrEqual(25);
	}
	const memory = sequence('a').filter((step) => step.path.startsWith('/memory'));
	expect(memory).toHaveLength(emptyMiB.length * 4);
	expect(sequence('b').every((step) => step.path.startsWith('/inst?m=boot'))).toBe(true);
	expect(sequence('c').every((step) => step.path.startsWith('/inst?m=render'))).toBe(true);
});

test('the generated empty-memory modules validate and size their memory', () => {
	expect(WebAssembly.validate(importModule())).toBe(true);
	const memory = new WebAssembly.Memory({ initial: 4, maximum: 65536 });
	new WebAssembly.Instance(new WebAssembly.Module(importModule()), { env: { memory } });
	for (const mib of emptyMiB) {
		const bytes = ownModule(mib * 16);
		expect(WebAssembly.validate(bytes)).toBe(true);
		const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
		expect((instance.exports.memory as WebAssembly.Memory).buffer.byteLength).toBe(
			mib * 1048576
		);
	}
});

test('parseDeployLog reads upload sizes, startup time and refusal lines', () => {
	const ok = parseDeployLog(
		'Total Upload: 13615.18 KiB / gzip: 4187.80 KiB\nWorker Startup Time: 2 ms\nUploaded cfw-folio-x (5 sec)\n'
	);
	expect(ok).toMatchObject({
		uploadKiB: 13615.18,
		gzipKiB: 4187.8,
		startupMs: 2,
		uploaded: true
	});
	expect(ok.refusal).toBeUndefined();
	const refused = parseDeployLog(
		'Total Upload: 1 KiB / gzip: 1 KiB\n\u001b[31m[ERROR]\u001b[0m Your Worker exceeded the size limit of 3 MiB\n'
	);
	expect(refused.startupMs).toBeNull();
	expect(refused.refusal?.[0]).toContain('exceeded the size limit');
});

const event = (entrypoint: string | undefined, path: string, outcome: string, cpu: number) =>
	JSON.stringify(
		{
			cpuTime: cpu,
			wallTime: 0,
			outcome,
			...(entrypoint ? { entrypoint } : {}),
			event: { request: { url: `https://x.invalid${path}` } },
			exceptions: outcome === 'ok' ? [] : [{ message: 'Worker exceeded memory limit.' }]
		},
		null,
		4
	);

test('summarizeSteps joins steps to Durable Object invocations and checks the image', () => {
	const steps = sequence('b').slice(0, 3);
	const body = (checksum?: number) =>
		JSON.stringify({
			memoryBytes: 67108864,
			moduleTag: 'ab',
			moduleCalls: 1,
			objectCalls: 1,
			checksum
		});
	const tail = [
		event(undefined, steps[0]!.path, 'ok', 0),
		event('BootImage', steps[0]!.path, 'ok', 9),
		event('BootImage', steps[1]!.path, 'ok', 7),
		event('BootImage', steps[2]!.path, 'exceededMemory', 0)
	].join('\n');
	const summary = summarizeSteps({
		variant: 'b',
		steps: [
			{ ...steps[0], status: 200, wallMs: 5, body: body(111) },
			{ ...steps[1], status: 200, wallMs: 5, body: body() },
			{ ...steps[2], status: 502, wallMs: 5, body: '{"error":"x"}' }
		],
		tail,
		expected: { boot: { checksum: 111, memoryBytes: 67108864 } }
	});
	expect(summary.rows.map((row) => row.cpuMs)).toEqual([9, 7, 0]);
	expect(summary.checksums).toEqual({ expected: 111, checked: 1, matching: 1 });
	expect(summary.refused).toEqual([
		{
			label: steps[2]!.label,
			outcome: 'exceededMemory',
			error: 'Worker exceeded memory limit.'
		}
	]);
	expect(summary.groups['boot-fresh']?.cpuMs).toMatchObject({ n: 2, max: 7 });
});
