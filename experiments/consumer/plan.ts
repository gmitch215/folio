/** Free-plan bounds the browser harness plans against (Cloudflare docs, read 2026-10-20). */
export const sessionBudget = {
	dailyMinutes: 10,
	attempts: 5,
	sessionSeconds: 75,
	secondsBetweenLaunches: 20,
	concurrent: 3
};

export interface HarnessParams {
	consumer: string;
	pairs: number;
	warmup: number;
	cases?: string[];
	budgetMs: number;
}

export function parseRequest(search: URLSearchParams): HarnessParams {
	const consumer = search.get('consumer') ?? '';
	if (!/^[a-z][a-z-]{1,31}$/.test(consumer)) throw new RangeError('consumer name');
	const whole = (key: string, fallback: number, low: number, high: number) => {
		const value = Number(search.get(key) ?? fallback);
		if (!Number.isInteger(value) || value < low || value > high)
			throw new RangeError(`${key} must be an integer from ${low} to ${high}`);
		return value;
	};
	const cases = search.get('cases')?.split(',').filter(Boolean);
	return {
		consumer,
		pairs: whole('pairs', 20, 1, 100),
		warmup: whole('warmup', 2, 0, 5),
		...(cases?.length ? { cases } : {}),
		budgetMs: whole('budget', 35, 5, 55) * 1000
	};
}

interface Session {
	startTime: number;
	endTime?: number;
}

/** Browser minutes since 00:00 UTC; a session with no end time counts to `now`. */
export function browserMinutesUsed(sessions: Session[], now: number) {
	const midnight = now - (now % 86_400_000);
	let milliseconds = 0;
	for (const session of sessions) {
		const end = session.endTime ?? now;
		const begin = Math.max(session.startTime, midnight);
		if (end > begin) milliseconds += end - begin;
	}
	return milliseconds / 60_000;
}

/** Worker and Durable Object requests a plan will make, against the 100,000 per day Free quota. */
export function requestBound(plan: { sessions: number; probeRequests: number }) {
	const workerRequests = plan.sessions * 6 + plan.probeRequests;
	return { workerRequests, durableObjectRequests: plan.sessions, freeDailyQuota: 100_000 };
}

export const bundleLimitBytes = 64 * 1024 * 1024;

/** Uncompressed size of a bundle's modules against the 64 MiB Free and Paid limit. */
export function bundleFit(parts: Record<string, number>) {
	const total = Object.values(parts).reduce((sum, bytes) => sum + bytes, 0);
	return {
		totalBytes: total,
		totalMiB: total / 1024 / 1024,
		headroomBytes: bundleLimitBytes - total,
		fits: total <= bundleLimitBytes
	};
}
