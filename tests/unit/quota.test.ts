import { expect, test } from 'vitest';
import {
	FREE_DAILY_ROWS,
	ROWS_PER_RUN,
	lacksRows,
	quotaExhausted,
	quotaNotice
} from '../../experiments/lib/quota.ts';

test('quotaExhausted recognizes the platform refusals and nothing else', () => {
	expect(quotaExhausted('Exceeded allowed rows written in Durable Objects free tier.')).toBe(
		true
	);
	expect(quotaExhausted('Daily request limit reached')).toBe(true);
	expect(quotaExhausted('exceeded its memory limit')).toBe(false);
	expect(quotaExhausted('')).toBe(false);
});

test('lacksRows compares what was used and what a run needs with the daily allowance', () => {
	expect(lacksRows(0)).toBe(false);
	expect(lacksRows(FREE_DAILY_ROWS - ROWS_PER_RUN)).toBe(false);
	expect(lacksRows(FREE_DAILY_ROWS - ROWS_PER_RUN + 1)).toBe(true);
	expect(lacksRows(50_000, 60_000)).toBe(true);
});

test('quotaNotice names the usage or the refusal and the next UTC midnight', () => {
	const now = new Date('2026-10-23T04:30:00Z');
	expect(quotaNotice(95_000, 12_000, now)).toBe(
		'skipped: the free account has written 95,000 of 100,000 Durable Object rows today, and a run needs 12,000; the quota resets at 2026-10-24T00:00:00.000Z'
	);
	expect(quotaNotice(null, 1_000, now)).toContain('refused a write');
	expect(quotaNotice(null, 1_000, new Date('2026-12-31T23:00:00Z'))).toContain(
		'2027-01-01T00:00:00.000Z'
	);
});
