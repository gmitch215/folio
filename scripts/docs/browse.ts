import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

type Params = Record<string, any>;
type Message = {
	id?: number;
	method?: string;
	params?: Params;
	result?: Params;
	sessionId?: string;
} & {
	error?: { message: string };
};

const out = resolve(process.argv[2] ?? 'typedoc');
const shots = process.argv[3] ?? '';
if (!shots) throw new Error('usage: bun scripts/docs/browse.ts <typedoc dir> <screenshot dir>');
mkdirSync(shots, { recursive: true });

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon'
};
const server = createServer((req, res) => {
	let path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
	if (path.endsWith('/')) path += 'index.html';
	const file = resolve(out, `.${path}`);
	if (!file.startsWith(out + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
		res.writeHead(404).end('missing');
		return;
	}
	res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
	res.end(readFileSync(file));
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bin = process.env['CHROME'] ?? (existsSync(mac) ? mac : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'folio-browse-'));
const chrome = spawn(
	bin,
	[
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--remote-debugging-port=0',
		`--user-data-dir=${profile}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

const portFile = join(profile, 'DevToolsActivePort');
let endpoint = '';
for (let i = 0; i < 100 && !endpoint; i++) {
	await sleep(100);
	const [port = '', path = ''] = existsSync(portFile)
		? readFileSync(portFile, 'utf8').split('\n')
		: [];
	if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
}
if (!endpoint) throw new Error(`${bin} did not open a DevTools port`);
const socket = new WebSocket(endpoint);
await new Promise<void>((ok, fail) => {
	socket.onopen = () => ok();
	socket.onerror = () => fail(new Error('DevTools socket failed'));
});

let next = 0;
const waiting = new Map<number, [(value: Params) => void, (error: Error) => void]>();
const handlers = new Set<(message: Message) => void>();
socket.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as Message;
	if (message.id === undefined) {
		for (const handler of handlers) handler(message);
		return;
	}
	const pending = waiting.get(message.id);
	waiting.delete(message.id);
	if (message.error) pending?.[1](new Error(message.error.message));
	else pending?.[0](message.result ?? {});
};
const send = (method: string, params: Params = {}, sessionId?: string) =>
	new Promise<Params>((ok, fail) => {
		const id = ++next;
		waiting.set(id, [ok, fail]);
		socket.send(JSON.stringify({ id, method, params, sessionId }));
	});

const keys: Record<string, Params> = {
	Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
	Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
	Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
	'/': { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' }
};

async function open(width: number, height: number, javaScript = true) {
	const created = await send('Target.createTarget', { url: 'about:blank' });
	const targetId = created['targetId'] as string;
	const attached = await send('Target.attachToTarget', { targetId, flatten: true });
	const sessionId = attached['sessionId'] as string;
	const call = (method: string, params: Params = {}) => send(method, params, sessionId);
	const errors: string[] = [];
	const loads: Array<() => void> = [];
	handlers.add((message) => {
		if (message.sessionId !== sessionId) return;
		const params = message.params ?? {};
		if (message.method === 'Runtime.exceptionThrown')
			errors.push(params['exceptionDetails'].exception?.description ?? 'exception');
		if (message.method === 'Runtime.consoleAPICalled' && params['type'] === 'error')
			errors.push(
				params['args'].map((a: Params) => a['value'] ?? a['description']).join(' ')
			);
		if (message.method === 'Page.loadEventFired') for (const done of loads.splice(0)) done();
	});
	await call('Page.enable');
	await call('Runtime.enable');
	await call('Emulation.setFocusEmulationEnabled', { enabled: true });
	await call('Emulation.setDeviceMetricsOverride', {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false
	});
	if (!javaScript) await call('Emulation.setScriptExecutionDisabled', { value: true });

	const navigated = async (method: string, params: Params) => {
		const done = new Promise<void>((ok) => loads.push(ok));
		await call(method, params);
		await done;
	};
	const evaluate = async <T, A extends unknown[]>(fn: (...args: A) => T, ...args: A) => {
		const result = await call('Runtime.evaluate', {
			expression: `(${fn})(...${JSON.stringify(args)})`,
			returnByValue: true,
			awaitPromise: true
		});
		if (result['exceptionDetails'])
			throw new Error(result['exceptionDetails'].exception?.description ?? 'evaluate failed');
		return result['result'].value as Awaited<T>;
	};
	const waitFor = async (fn: () => unknown, timeout: number) => {
		for (let spent = 0; spent < timeout; spent += 100) {
			if (await evaluate(fn)) return true;
			await sleep(100);
		}
		return false;
	};
	return {
		errors,
		evaluate,
		waitFor,
		goto: (path: string) => navigated('Page.navigate', { url: `${base}/${path}` }),
		reload: () => navigated('Page.reload', {}),
		scheme: (value: 'light' | 'dark') =>
			call('Emulation.setEmulatedMedia', {
				features: [{ name: 'prefers-color-scheme', value }]
			}),
		click: (selector: string) =>
			evaluate((s) => (document.querySelector(s) as HTMLElement).click(), selector),
		focus: (selector: string) =>
			evaluate((s) => (document.querySelector(s) as HTMLElement).focus(), selector),
		fill: (selector: string, value: string) =>
			evaluate(
				(s, v) => {
					const input = document.querySelector(s) as HTMLInputElement;
					input.focus();
					input.value = v;
					input.dispatchEvent(new Event('input', { bubbles: true }));
				},
				selector,
				value
			),
		press: async (name: string) => {
			const key = keys[name];
			if (!key) throw new Error(`no key ${name}`);
			await call('Input.dispatchKeyEvent', {
				type: key['text'] ? 'keyDown' : 'rawKeyDown',
				...key
			});
			await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key, text: undefined });
		},
		box: (selector: string) =>
			evaluate((s) => {
				const r = document.querySelector(s)?.getBoundingClientRect();
				return r ? { width: Math.round(r.width), height: Math.round(r.height) } : null;
			}, selector),
		shot: async (name: string) => {
			const image = await call('Page.captureScreenshot', { format: 'png' });
			writeFileSync(join(shots, name), Buffer.from(image['data'] as string, 'base64'));
		},
		close: () => send('Target.closeTarget', { targetId })
	};
}

const pages = {
	landing: 'index.html',
	module: 'documents/docs_modules_core.html',
	advanced: 'documents/ADVANCED_USAGE.html',
	report: 'documents/TECHNICAL_REPORT.html',
	api: 'classes/index.Folio.html'
};
const widths = [360, 768, 1280];
const say = (line: string) => console.log(line);

for (const [name, path] of Object.entries(pages)) {
	for (const width of widths) {
		const page = await open(width, 900);
		await page.goto(path);
		await page.waitFor(
			() =>
				Array.from(document.querySelectorAll('pre > code.mermaid, pre > code.math')).every(
					(code) => code.parentElement?.hidden
				),
			8000
		);
		await sleep(300);
		const m = await page.evaluate(() => ({
			scroll: document.documentElement.scrollWidth,
			inner: window.innerWidth,
			sidebar: (() => {
				const r = document.getElementById('docs-sidebar')?.getBoundingClientRect();
				return r ? `${Math.round(r.x)},${Math.round(r.width)}` : 'none';
			})(),
			toc: document.querySelector('.docs-toc')
				? getComputedStyle(document.querySelector('.docs-toc') as Element).display
				: false,
			diagrams: document.querySelectorAll('.docs-render svg').length,
			math: document.querySelectorAll('.docs-render .katex').length,
			source: document.querySelectorAll('pre > code.mermaid, pre > code.math').length,
			wide: Array.from(document.querySelectorAll('main *'))
				.filter((e) => !e.closest('table, pre, .docs-render'))
				.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
				.slice(0, 3)
				.map((e) => `${e.tagName.toLowerCase()}[${(e.textContent ?? '').slice(0, 40)}]`)
				.join(' ')
		}));
		await page.shot(`${name}-${width}.png`);
		say(
			`shot ${name} ${width}: scrollWidth ${m.scroll} innerWidth ${m.inner} overflow ${m.scroll > m.inner} sidebar x,w ${m.sidebar} toc ${m.toc} diagrams ${m.diagrams} math ${m.math} fences ${m.source}${m.scroll > m.inner ? ` wide ${m.wide}` : ''} errors ${page.errors.length}${page.errors.length ? ` ${page.errors[0]}` : ''}`
		);
		await page.close();
	}
}

for (const mode of ['click', 'slash'] as const) {
	const page = await open(1280, 900);
	await page.goto('index.html');
	await sleep(500);
	if (mode === 'click') await page.click('#tsd-search-trigger');
	else await page.press('/');
	await page.fill('#tsd-search-input', 'folio');
	await page.waitFor(() => document.querySelectorAll('#tsd-search-results li').length > 0, 10000);
	const found = await page.evaluate(() => {
		const items = Array.from(document.querySelectorAll<HTMLElement>('#tsd-search-results li'));
		return { n: items.length, first: items[0]?.innerText ?? '' };
	});
	if (mode === 'click') await page.shot('search-1280.png');
	say(
		`search via ${mode}: ${found.n} results, first "${found.first.replace(/\s+/g, ' ').slice(0, 60)}"`
	);
	await page.close();
}

{
	const page = await open(360, 800);
	await page.goto(pages.module);
	await sleep(500);
	const active = () =>
		page.evaluate(() => {
			const a = document.activeElement as HTMLElement | null;
			return `${a?.tagName}.${a?.className}|${a?.textContent?.trim().slice(0, 20)}`;
		});
	const order: string[] = [];
	for (let i = 0; i < 3; i++) {
		await page.press('Tab');
		order.push(await active());
	}
	say(`tab order: ${order.join(' > ')}`);
	await page.focus('.docs-menu');
	const sizeMenu = await page.box('.docs-menu');
	await page.press('Enter');
	await sleep(300);
	const open_ = await page.evaluate(() =>
		(document.getElementById('docs-sidebar') as HTMLElement).matches(':popover-open')
	);
	const inside = await page.evaluate(() => !!document.activeElement?.closest('#docs-sidebar'));
	const rows = await page.evaluate(() => {
		const h = Array.from(
			document.querySelectorAll('#docs-sidebar summary, #docs-sidebar a')
		).map((e) => e.getBoundingClientRect().height);
		return Math.min(...h.filter((v) => v > 0));
	});
	await page.shot('drawer-360.png');
	await page.press('Escape');
	await sleep(300);
	const closed = await page.evaluate(
		() => !(document.getElementById('docs-sidebar') as HTMLElement).matches(':popover-open')
	);
	const back = await active();
	say(
		`drawer: opens by Enter ${open_}, focus moved inside ${inside}, Escape closes ${closed}, focus returns to ${back}, menu button ${sizeMenu?.width ?? 0}x${sizeMenu?.height ?? 0}, smallest row ${rows}px`
	);
	await page.close();
}

{
	const page = await open(1280, 900);
	await page.goto(pages.module);
	await sleep(500);
	await page.scheme('light');
	await page.click('#docs-theme');
	const theme = await page.evaluate(() => [
		document.documentElement.dataset['theme'],
		localStorage.getItem('tsd-theme')
	]);
	await page.shot('module-1280-toggled.png');
	await page.reload();
	await sleep(300);
	const kept = await page.evaluate(() => document.documentElement.dataset['theme']);
	say(`theme toggle: ${theme.join(' / ')}, after reload ${kept}`);
	await page.scheme('dark');
	await page.evaluate(() => localStorage.removeItem('tsd-theme'));
	await page.reload();
	await sleep(300);
	await page.shot('module-1280-os-dark.png');
	await page.evaluate(() => localStorage.removeItem('tsd-theme'));
	await page.close();
}

{
	const page = await open(1280, 700);
	await page.goto(pages.advanced);
	await sleep(500);
	let worst = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 90; i++) {
		await page.press('Tab');
		const top = await page.evaluate(() => {
			const a = document.activeElement as HTMLElement | null;
			if (
				!a ||
				a === document.body ||
				a.closest('header') ||
				a.closest('.docs-sidebar') ||
				a.matches('.docs-skip')
			)
				return null;
			return (
				a.getBoundingClientRect().top -
				(document.querySelector('header') as Element).getBoundingClientRect().bottom
			);
		});
		if (top !== null) worst = Math.min(worst, top);
	}
	say(`focus clearance below the top bar over 90 tab stops: smallest gap ${Math.round(worst)}px`);
	await page.close();
}

{
	const page = await open(1280, 900, false);
	await page.goto(pages.module);
	const info = await page.evaluate(() => ({
		sidebar: getComputedStyle(document.getElementById('docs-sidebar') as Element).display,
		current: document.querySelector('#docs-sidebar a[aria-current="page"]')?.textContent,
		body: getComputedStyle(document.body).display,
		themeHidden: (document.getElementById('docs-theme') as HTMLElement).hidden
	}));
	await page.shot('module-1280-nojs.png');
	say(
		`no JS: sidebar ${info.sidebar}, current "${info.current}", body ${info.body}, theme button hidden ${info.themeHidden}`
	);
	await page.close();
}

socket.close();
chrome.kill();
server.close();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
