import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { browserExtractionAssets } from './prepare.ts';

/** Runs actual Chromium against isolated loopback assets; no managed deployment is implied. */
export async function runLocalExtraction() {
	const tooling = process.env.FOLIO_PLAYWRIGHT_PACKAGE;
	const playwright: any = tooling
		? createRequire(tooling)('playwright-core')
		: await import('playwright-core' as string);
	const assets: Record<string, [string, string | Buffer]> = browserExtractionAssets();
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
		if (process.env.FOLIO_DISABLE_JSPI === '1')
			await page.addInitScript(() => {
				const wasm = WebAssembly as any;
				(globalThis as any).folioJspiOriginallyAvailable =
					typeof wasm.Suspending === 'function';
				(globalThis as any).folioJspiDisabledForProbe = true;
				Object.defineProperty(wasm, 'Suspending', { value: undefined, configurable: true });
				Object.defineProperty(wasm, 'promising', { value: undefined, configurable: true });
			});
		await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/arena`);
		await page.waitForFunction(
			() => typeof (globalThis as any).runBrowserExtractionProbe === 'function'
		);
		const result = await page.evaluate(() => (globalThis as any).runBrowserExtractionProbe());
		assert.equal(result.passed, true, result.error);
		return { environment: 'local-chromium-only', ...result };
	} finally {
		if (browser) await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

if (import.meta.main) console.log(JSON.stringify(await runLocalExtraction(), null, 2));
