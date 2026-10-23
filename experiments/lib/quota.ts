/** Rows written the Free plan allows an account per UTC day, across every Durable Object. */
export const FREE_DAILY_ROWS = 100_000;

/** Rows a live run needs left; its objects write almost no rows, so this is a margin, not a measurement. */
export const ROWS_PER_RUN = 1_000;

const quotaText = /Exceeded allowed rows written in Durable Objects free tier|daily request limit/i;

/** Whether an answer says the account's free quota for today is spent. */
export function quotaExhausted(text: string): boolean {
	return quotaText.test(text);
}

/** Whether the account has written so many rows today that a run needing `needed` would not fit. */
export function lacksRows(used: number, needed = ROWS_PER_RUN): boolean {
	return used + needed > FREE_DAILY_ROWS;
}

/** The notice a skipped run prints: what was used, what a run needs and when the quota resets. */
export function quotaNotice(used: number | null, needed = ROWS_PER_RUN, now = new Date()): string {
	const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
	const limit = FREE_DAILY_ROWS.toLocaleString('en-US');
	const state =
		used === null
			? `the platform refused a write because the free account's ${limit} daily Durable Object rows are spent`
			: `the free account has written ${used.toLocaleString('en-US')} of ${limit} Durable Object rows today`;
	return `skipped: ${state}, and a run needs ${needed.toLocaleString('en-US')}; the quota resets at ${reset.toISOString()}`;
}
