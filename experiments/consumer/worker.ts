import { history, launch, limits } from '@cloudflare/playwright';
import assets from './build/assets.json' with { type: 'json' };
import { browserMinutesUsed, parseRequest, sessionBudget } from './plan.ts';

interface Env {
	BROWSER: Parameters<typeof launch>[0];
	GATE: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

const headers = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cache-Control': 'no-store'
};

type Asset = { type: string; text?: string; base64?: string };
const table = assets as Record<string, Asset>;

function serve(entry: Asset) {
	const body = entry.text ?? Uint8Array.from(atob(entry.base64!), (char) => char.charCodeAt(0));
	return new Response(body, { headers: { ...headers, 'content-type': entry.type } });
}

export class ConsumerGate {
	state: DurableObjectState;
	env: Env;
	busy = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request) {
		if (this.busy) return new Response('Consumer harness already running', { status: 409 });
		this.busy = true;
		let browser: Awaited<ReturnType<typeof launch>> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		const started = performance.now();
		try {
			const attempts =
				((await this.state.storage.get('attempts')) as number | undefined) ?? 0;
			if (attempts >= sessionBudget.attempts)
				return new Response('Session attempt budget exhausted', { status: 429 });
			const { origin, search } = (await request.json()) as { origin: string; search: string };
			const parsed = parseRequest(new URLSearchParams(search));
			const used = browserMinutesUsed(await history(this.env.BROWSER), Date.now());
			if (used + sessionBudget.sessionSeconds / 60 > sessionBudget.dailyMinutes)
				return Response.json(
					{ passed: false, error: 'daily browser minutes', usedMinutes: used },
					{ status: 429 }
				);
			await this.state.storage.put('attempts', attempts + 1);
			const run = (async () => {
				browser = await launch(this.env.BROWSER);
				if (finished) throw new Error('launch exceeded session budget');
				const page = await browser.newPage();
				page.setDefaultTimeout(sessionBudget.sessionSeconds * 1000 - 10000);
				await page.goto(`${origin}/arena`, { waitUntil: 'load', timeout: 15000 });
				return page.evaluate(
					(arg: unknown) => (globalThis as any).runConsumerHarness(arg),
					parsed
				);
			})();
			const result = await Promise.race([
				run,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('session budget')),
						sessionBudget.sessionSeconds * 1000
					);
				})
			]);
			return Response.json({
				attempt: attempts + 1,
				sessionWallMs: performance.now() - started,
				browserMinutesBefore: used,
				...result
			});
		} catch (error: any) {
			return Response.json(
				{
					passed: false,
					error: String(error.stack ?? error),
					sessionWallMs: performance.now() - started
				},
				{ status: 502 }
			);
		} finally {
			finished = true;
			clearTimeout(timer);
			try {
				await browser?.close();
			} finally {
				this.busy = false;
			}
		}
	}
}

const authorized = (request: Request, env: Env) =>
	Boolean(env.PROBE_TOKEN) &&
	request.headers.get('authorization') === `Bearer ${env.PROBE_TOKEN}`;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/run' || url.pathname === '/meter') {
			if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
			if (url.pathname === '/meter') {
				const [closed, current] = await Promise.all([
					history(env.BROWSER),
					limits(env.BROWSER)
				]);
				return Response.json({
					usedMinutes: browserMinutesUsed(closed, Date.now()),
					recent: closed.length,
					maxConcurrentSessions: current.maxConcurrentSessions,
					activeSessions: current.activeSessions.length,
					secondsUntilNextAcquisition:
						current.timeUntilNextAllowedBrowserAcquisition / 1000
				});
			}
			if (request.method !== 'POST')
				return new Response('Method not allowed', { status: 405 });
			const gate = env.GATE.get(env.GATE.idFromName('consumer-gate')) as {
				fetch(url: string, init: RequestInit): Promise<Response>;
			};
			return gate.fetch('https://gate/run', {
				method: 'POST',
				body: JSON.stringify({ origin: url.origin, search: url.search })
			});
		}
		const entry = table[url.pathname];
		if (request.method !== 'GET' || !entry) return new Response('Not found', { status: 404 });
		return serve(entry);
	}
} satisfies ExportedHandler<Env>;
