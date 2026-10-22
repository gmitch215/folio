import { expect, test } from 'vitest';
import { compareRuntimes, parseJsonl } from '../../scripts/analyze/runtimecmp.ts';

type Row = { kind: string; [key: string]: any };

const run = (ms: number, sha: string, open: number): Row[] => [
	{
		kind: 'environment',
		contextsOpenMs: open,
		boots: [{ openMs: open }]
	},
	{ kind: 'warmup', firstRenderMs: [ms, ms] },
	{
		kind: 'oracle',
		perUrl: [
			{ url: '/', ms, bytes: 1, sha256: sha },
			{ url: '/node/1', ms, bytes: 1, sha256: sha }
		]
	},
	{
		kind: 'sample',
		arm: 'serial',
		width: 1,
		pages: 2,
		wallMs: 2 * ms,
		busyMs: [2 * ms],
		processCpuMs: 10,
		round: 0
	}
];

test('identical hashes and a 2x bun render ratio', () => {
	const result = compareRuntimes(run(100, 'abc', 500), run(200, 'abc', 1000));
	expect(result.hashes).toEqual({ urls: 2, identical: true, mismatches: [] });
	expect(result.steady.oraclePageMs).toMatchObject({ bunOverNode: 2 });
	expect(result.steady.serial).toMatchObject({ busyMsPerPage: { bunOverNode: 2 } });
	expect(result.contextOpenMs).toMatchObject({ bunOverNode: 2 });
});

test('one differing sha256 is reported as a mismatch', () => {
	const bun = run(100, 'abc', 500);
	bun[2]!.perUrl[1].sha256 = 'xyz';
	const result = compareRuntimes(run(100, 'abc', 500), bun);
	expect(result.hashes).toEqual({ urls: 2, identical: false, mismatches: ['/node/1'] });
});

test('parseJsonl skips blank lines', () => {
	expect(parseJsonl('{"kind":"a"}\n\n{"kind":"b"}\n')).toEqual([{ kind: 'a' }, { kind: 'b' }]);
});
