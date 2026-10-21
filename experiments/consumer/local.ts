import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { consumerAssets, type Asset } from './prepare.ts';

/** Runs the harness in a local Chromium over loopback assets; the result is labeled local and is not Cloudflare evidence. */
export async function runLocal(consumer: string, pairs: number, cases?: string[]) {
	const tooling = process.env.FOLIO_PLAYWRIGHT_PACKAGE;
	const playwright: any = tooling
		? createRequire(tooling)('playwright-core')
		: await import('playwright-core' as string);
	const assets: Record<string, Asset> = await consumerAssets([consumer]);
	const server = createServer((request, response) => {
		const asset = assets[(request.url ?? '').split('?')[0]!];
		response.writeHead(asset ? 200 : 404, {
			'content-type': asset?.type ?? 'text/plain',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Cache-Control': 'no-store'
		});
		response.end(asset ? (asset.text ?? Buffer.from(asset.base64!, 'base64')) : 'Not found');
	});
	let browser: any;
	try {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		browser = await playwright.chromium.launch({ headless: true });
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/arena`);
		await page.waitForFunction(
			() => typeof (globalThis as any).runConsumerHarness === 'function'
		);
		const result = await page.evaluate(
			(arg: unknown) => (globalThis as any).runConsumerHarness(arg),
			{ consumer, pairs, warmup: 2, budgetMs: 60000, ...(cases ? { cases } : {}) }
		);
		assert.equal(result.passed, true, result.error);
		return { environment: 'local-chromium-only', ...result };
	} finally {
		if (browser) await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
}

// usage: node experiments/consumer/local.ts CONSUMER PAIRS [OUTPUT.json] [CASE,...]
if (import.meta.main) {
	const [consumer, pairs, output, cases] = process.argv.slice(2);
	const result = await runLocal(
		consumer ?? 'kernel-control',
		Number(pairs ?? 3),
		cases?.split(',')
	);
	if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
	console.log(
		JSON.stringify({
			passed: result.passed,
			rows: result.rows.length,
			elapsedMs: result.elapsedMs
		})
	);
}
