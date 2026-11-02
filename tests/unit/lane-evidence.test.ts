import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assertClean,
	exportRun,
	scrubTail,
	tailLines
} from '../../scripts/research/lane-evidence.ts';

const tail = '{\n\t"cpuTime": 3,\n\t"wallTime": 4\n}\n{\n\t"cpuTime": 5,\n\t"wallTime": 9\n}\n';

describe('lane evidence export', () => {
	it('splits a pretty-printed tail capture into one scrubbed line per event', () => {
		const lines = tailLines(tail).map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ cpuTime: 3, wallTime: 4 });
		expect(lines[1]).toMatchObject({ cpuTime: 5, wallTime: 9 });
		expect(tailLines('')).toEqual([]);
	});

	it('keeps only the measurement fields of a tail event', () => {
		const event = {
			scriptName: 's',
			outcome: 'ok',
			wallTime: 7,
			cpuTime: 6,
			event: {
				rpcMethod: 'execute',
				request: {
					url: 'https://x.y.workers.dev/run?arm=a&rid=3',
					method: 'GET',
					headers: { authorization: 'Bearer t', 'cf-connecting-ip': '203.0.113.9' },
					cf: { colo: 'IAD', city: 'Somewhere', asn: 1 }
				},
				response: { status: 200 }
			}
		};
		const kept = scrubTail(event);
		expect(kept).toMatchObject({
			path: '/run?arm=a&rid=3',
			colo: 'IAD',
			status: 200,
			cpuTime: 6
		});
		expect(JSON.stringify(kept)).not.toMatch(/workers\.dev|authorization|203\.0|Somewhere/);
	});

	it('refuses a workers.dev name and a credential value', () => {
		expect(() => assertClean('x', 'https://a.b.workers.dev', [])).toThrow(/workers\.dev/);
		expect(() => assertClean('x', 'id 0123abcd', ['0123abcd'])).toThrow(/credential/);
		expect(() => assertClean('x', 'plain', [''])).not.toThrow();
		expect(() => assertClean('x', '{"authorization":"b"}', [])).toThrow(/headers/);
		expect(() => assertClean('x', 'from 203.0.113.9', [])).toThrow(/IP/);
	});

	it('writes the four study files and keeps account listings out', () => {
		const run = mkdtempSync(join(tmpdir(), 'lane-run-'));
		const out = join(mkdtempSync(join(tmpdir(), 'lane-out-')), 'study');
		writeFileSync(join(run, 'requests.jsonl'), '{"rid":1}\n');
		writeFileSync(join(run, 'summary.json'), '{"rows":[]}');
		writeFileSync(join(run, 'run.json'), '{"name":"n"}');
		writeFileSync(join(run, 'baseline.json'), '{"scripts":["secret-script"]}');
		writeFileSync(join(run, 'tail-a.jsonl'), tail);
		const names = exportRun(run, out, ['']);
		expect(names).toEqual(['raw.jsonl', 'tail.jsonl', 'summary.json', 'environment.json']);
		expect(readFileSync(join(out, 'tail.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
		expect(JSON.parse(readFileSync(join(out, 'environment.json'), 'utf8')).run.name).toBe('n');
		expect(names.join()).not.toContain('baseline');
	});

	it('fails the export when a file carries a secret', () => {
		const run = mkdtempSync(join(tmpdir(), 'lane-run-'));
		writeFileSync(join(run, 'requests.jsonl'), '{"leak":"tok-123"}\n');
		writeFileSync(join(run, 'summary.json'), '{}');
		expect(() => exportRun(run, join(run, 'out'), ['tok-123'])).toThrow(/credential/);
	});
});
