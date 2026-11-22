import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Interleaved A/B on one deployed Drupal site whose Durable Object honors the alarm-mode header
// (see the README for the contract). Blocks alternate the arms: `legacy` sends
// `x-alarm-mode: legacy`, `isolated` sends nothing. Each block clears the caches once and then
// visits four admin pages, so every page after the clear renders cold.
// WORKER_URL is the site origin and ACCESS_FILE a JSON file holding `{ "cookie": "..." }` for an
// administrator login; neither is printed or written to the output.
const origin = process.env.WORKER_URL;
const accessFile = process.env.ACCESS_FILE;
if (!origin || !accessFile) throw new Error('set WORKER_URL and ACCESS_FILE');
const cookie = (JSON.parse(readFileSync(accessFile, 'utf8')) as { cookie: string }).cookie;
const blocks = Number(process.env.BLOCKS ?? 50);
const outDir = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}/ab-${Date.now()}.jsonl`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PERF = '/admin/config/development/performance';
const pages: [string, string][] = [
	['status', '/admin/reports/status'],
	['modules', '/admin/modules'],
	['content', '/admin/content'],
	['perf', PERF]
];

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
const unescape = (s: string) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/&#039;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');

function clearForm(html: string): Record<string, string> | undefined {
	for (const form of html.match(/<form[\s\S]*?<\/form>/g) ?? []) {
		if (!form.includes('name="form_id" value="system_clear_cache"')) continue;
		const fields: Record<string, string> = {};
		for (const tag of form.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
			const name = attr(tag, 'name');
			if (name) fields[name] = unescape(attr(tag, 'value'));
		}
		return fields;
	}
	return undefined;
}

async function go(arm: string, block: number, kind: string, url: string, init: RequestInit = {}) {
	const start = Date.now();
	let status = 0;
	let body = '';
	let err = '';
	let mode = '';
	let early = '';
	let isolated = '';
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const res = await fetch(origin + url, {
				redirect: 'manual',
				...init,
				headers: {
					cookie: cookie,
					...(arm === 'legacy' ? { 'x-alarm-mode': 'legacy' } : {}),
					...((init.headers as Record<string, string> | undefined) ?? {})
				}
			});
			status = res.status;
			mode = res.headers.get('x-alarm-mode') ?? '';
			early = res.headers.get('x-earlier-moves') ?? '';
			isolated = res.headers.get('x-isolated-moves') ?? '';
			body = await res.text();
			err = '';
			break;
		} catch (e) {
			err = String(e).slice(0, 80);
			if (!/fetch failed/.test(err)) break;
			await sleep(20000);
		}
	}
	const row = { block, arm, kind, url, start, end: Date.now(), status, bytes: body.length, err };
	appendFileSync(outFile, `${JSON.stringify({ ...row, mode, early, isolated })}\n`);
	return body;
}

for (let block = 0; block < blocks; block++) {
	const arm = block % 2 === 0 ? 'legacy' : 'isolated';
	const page = await go(arm, block, 'perf', PERF);
	const fields = clearForm(page);
	if (fields) {
		await go(arm, block, 'clear', PERF, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ...fields, op: 'Clear all caches' }).toString()
		});
	}
	await sleep(1000);
	for (const [kind, url] of pages) {
		await go(arm, block, kind, url);
		await sleep(1500);
	}
}
console.log(outFile);
