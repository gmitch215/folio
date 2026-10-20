import { launch } from '@cloudflare/playwright';
import fixture from '../../build/fixture.wasm';
import sharing from '../../build/sharing.wasm';
import probeSource from './build/probe.js';

interface Env {
	BROWSER: Parameters<typeof launch>[0];
	GATE: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

const browserSource = probeSource.replace(/^export /gm, '');

const headers = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cache-Control': 'no-store'
};

function asset(body: BodyInit, type: string) {
	return new Response(body, { headers: { ...headers, 'content-type': type } });
}

export class BrowserGate {
	state: DurableObjectState;
	env: Env;
	busy = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request) {
		if (this.busy) return new Response('Browser probe already running', { status: 409 });
		this.busy = true;
		let browser: Awaited<ReturnType<typeof launch>> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let launchPending = false;
		let finished = false;
		const started = performance.now();
		try {
			const attempts =
				((await this.state.storage.get('attempts')) as number | undefined) ?? 0;
			if (attempts >= 2) {
				return new Response('Browser probe session budget exhausted', { status: 429 });
			}
			await this.state.storage.put('attempts', attempts + 1);
			const { origin } = (await request.json()) as { origin: string };
			const run = (async () => {
				launchPending = true;
				try {
					browser = await launch(this.env.BROWSER);
				} finally {
					launchPending = false;
				}
				if (finished) {
					await browser.close();
					throw new Error('Browser launch exceeded session budget');
				}
				const page = await browser.newPage();
				page.setDefaultTimeout(70000);
				await page.goto(`${origin}/arena`, { waitUntil: 'load', timeout: 15000 });
				return page.evaluate(() => (globalThis as any).runBrowserProbe());
			})();
			run.finally(() => {
				if (finished) this.busy = false;
			}).catch(() => {});
			const result = await Promise.race([
				run,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Browser session 85-second budget')),
						85000
					);
				})
			]);
			return Response.json({
				attempt: attempts + 1,
				sessionWallMs: performance.now() - started,
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
				if (browser) await browser.close();
			} finally {
				if (!launchPending) this.busy = false;
			}
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/run') {
			if (
				!env.PROBE_TOKEN ||
				request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`
			) {
				return new Response('Unauthorized', { status: 401 });
			}
			if (request.method !== 'POST')
				return new Response('Method not allowed', { status: 405 });
			const gate = env.GATE.get(env.GATE.idFromName('bounded-probe')) as {
				fetch(url: string, init: RequestInit): Promise<Response>;
			};
			return gate.fetch('https://gate/run', {
				method: 'POST',
				body: JSON.stringify({ origin: url.origin })
			});
		}
		if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
		if (url.pathname === '/arena') {
			return asset(
				'<!doctype html><meta charset="utf-8"><title>Folio arena probe</title><script src="/probe.js"></script>',
				'text/html; charset=utf-8'
			);
		}
		if (url.pathname === '/probe.js') return asset(browserSource, 'application/javascript');
		if (url.pathname === '/lane.js') {
			return asset(`${browserSource}\nbrowserLane();`, 'application/javascript');
		}
		if (url.pathname === '/sharing.wasm') return asset(sharing, 'application/wasm');
		if (url.pathname === '/fixture.wasm') return asset(fixture, 'application/wasm');
		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
