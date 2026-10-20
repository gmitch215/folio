import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { transpileProbe } from './prepare.ts';

// the page and its lane worker are the same assets the Worker serves, from a loopback server
export async function runLocal() {
	// playwright-core is not a dependency: install it and a Chromium to run this by hand
	const playwright: any = await import('playwright-core' as string).catch(() => {
		throw new Error('install playwright-core (and a Chromium) to run the local browser probe');
	});
	const source = transpileProbe().replace(/^export /gm, '');
	const [sharing, fixture] = (await Promise.all(
		['sharing', 'fixture'].map((name) =>
			readFile(new URL(`../../build/${name}.wasm`, import.meta.url))
		)
	)) as [Buffer, Buffer];
	const assets: Record<string, [string, string | Buffer]> = {
		'/arena': [
			'text/html',
			'<!doctype html><title>Folio local arena</title><script src="/probe.js"></script>'
		],
		'/probe.js': ['application/javascript', source],
		'/lane.js': ['application/javascript', `${source}\nbrowserLane();`],
		'/sharing.wasm': ['application/wasm', sharing],
		'/fixture.wasm': ['application/wasm', fixture]
	};
	const server = createServer((request, response) => {
		const asset = assets[request.url ?? ''];
		response.writeHead(asset ? 200 : 404, {
			'content-type': asset?.[0] ?? 'text/plain',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Cache-Control': 'no-store'
		});
		response.end(asset?.[1] ?? 'Not found');
	});
	let browser: any;
	try {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		browser = await playwright.chromium.launch({ headless: true });
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/arena`);
		const result = await page.evaluate(() => (globalThis as any).runBrowserProbe());
		assert.equal(result.passed, true, result.error);
		return { environment: 'local-chromium-only', ...result };
	} finally {
		if (browser) await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

if (import.meta.main) console.log(JSON.stringify(await runLocal(), null, 2));
