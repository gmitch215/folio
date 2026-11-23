import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const out = process.argv[2] ?? 'typedoc';
const pages = (readdirSync(out, { recursive: true }) as string[])
	.map((p) => p.replaceAll('\\', '/'))
	.filter((p) => p.endsWith('.html') && !p.startsWith('assets/') && !p.startsWith('media/'));
const html = new Map(pages.map((p) => [p, readFileSync(join(out, p), 'utf8')]));
const idsOf = (source: string) => [...source.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? '');
const ids = new Map([...html].map(([p, s]) => [p, new Set(idsOf(s))]));
const isGuide = (p: string) => p === 'index.html' || p.startsWith('documents/');

const broken: string[] = [];
let links = 0;
for (const [page, source] of html) {
	for (const m of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
		const raw = m[1] ?? '';
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
		links++;
		const [pathPart = '', hash = ''] = raw.replace(/\?[^#]*/, '').split('#');
		const target = pathPart === '' ? page : join(dirname(page), pathPart).replaceAll('\\', '/');
		const full = resolve(out, target);
		let file = target;
		if (existsSync(full) && statSync(full).isDirectory()) file = join(target, 'index.html');
		if (!existsSync(resolve(out, file))) {
			broken.push(`${page}: ${raw}`);
			continue;
		}
		if (
			hash &&
			file.endsWith('.html') &&
			!(ids.get(file) ?? new Set()).has(decodeURIComponent(hash))
		)
			broken.push(`${page}: ${raw} (anchor)`);
	}
}

const rows = (label: string, list: string[]) => {
	console.log(`${label}: ${list.length}`);
	for (const item of list.slice(0, 8)) console.log(`  ${item}`);
};

const guides = pages.filter(isGuide);
const api = pages.filter((p) => !isGuide(p));
const dup = (set: string[]) =>
	set.filter((p) => {
		const all = idsOf(html.get(p) ?? '');
		return new Set(all).size !== all.length;
	});
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

console.log(
	`pages ${pages.length} (guides ${guides.length}, api ${api.length}), relative links ${links}`
);
rows('unresolved relative links', broken);
rows(
	'guide pages without the sidebar',
	guides.filter((p) => !html.get(p)?.includes('id="docs-sidebar"'))
);
rows(
	'pages with more than one h1',
	pages.filter((p) => count(html.get(p) ?? '', /<h1[\s>]/g) > 1)
);
rows(
	'pages with no h1',
	pages.filter((p) => count(html.get(p) ?? '', /<h1[\s>]/g) === 0)
);
rows('guide pages with duplicate ids', dup(guides));
rows('api pages with duplicate ids', dup(api));
rows(
	'guide pages without exactly one aria-current="page" link',
	guides.filter((p) => count(html.get(p) ?? '', /<a [^>]*aria-current="page"/g) !== 1)
);

const landmarks = (set: string[]) => {
	const tally = new Map<string, number>();
	for (const p of set) {
		const s = html.get(p) ?? '';
		const key = `header ${count(s, /<header[\s>]/g)}, nav ${count(s, /<nav[\s>]/g)}, main ${count(s, /<main[\s>]/g)}, footer ${count(s, /<footer[\s>]/g)}`;
		tally.set(key, (tally.get(key) ?? 0) + 1);
	}
	return [...tally].map(([k, n]) => `${n} pages: ${k}`);
};
console.log('landmarks, guide pages');
for (const l of landmarks(guides)) console.log(`  ${l}`);
console.log('landmarks, api pages');
for (const l of landmarks(api)) console.log(`  ${l}`);

// contrast, from the tokens in render.css over typedoc's own defaults
const hex = (s: string) => {
	const h = s.replace('#', '');
	const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
	return [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16));
};
const lum = (c: string) => {
	const [r = 0, g = 0, b = 0] = hex(c).map((v) => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
	const [hi = 0, lo = 0] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const tokens = (theme: 'light' | 'dark') => {
	const map = new Map<string, string>();
	for (const file of [join(out, 'assets/style.css'), 'scripts/docs/render.css'])
		for (const m of readFileSync(file, 'utf8').matchAll(
			new RegExp(`--${theme}-([a-z-]+):\\s*(#[0-9a-fA-F]{3,6})\\s*;`, 'g')
		))
			map.set(m[1] ?? '', m[2] ?? '');
	return map;
};
// [foreground token, background token, minimum, use]
const pairs: [string, string, number, string][] = [
	['color-text', 'color-background', 4.5, 'body text'],
	['color-text', 'color-background-secondary', 4.5, 'text on the page tint and table rows'],
	['color-text', 'color-accent', 4.5, 'search box on hover'],
	['color-text-aside', 'color-background', 4.5, 'sidebar and outline links, eyebrow, version'],
	['color-text-aside', 'color-background-secondary', 4.5, 'sidebar and outline links on hover'],
	['color-text-aside', 'color-accent', 4.5, 'search box text on hover'],
	['color-link', 'color-background', 4.5, 'links, pager titles, skip link'],
	['color-link', 'color-background-secondary', 4.5, 'links on the page tint'],
	['color-link', 'color-accent', 4.5, 'active sidebar link'],
	['color-contrast-text', 'color-background-active', 4.5, 'selected search result'],
	['docs-edge', 'color-background', 3, 'search box and key hint edge, chevron'],
	['docs-edge', 'color-background-secondary', 3, 'search box edge on its own fill'],
	['color-link', 'color-background', 3, 'active-link left bar'],
	['color-focus-outline', 'color-background', 3, 'focus ring'],
	['color-focus-outline', 'color-background-secondary', 3, 'focus ring on the tint'],
	['color-focus-outline', 'color-accent', 3, 'focus ring on the active link'],
	['docs-rule', 'color-background', 0, 'dividers and inactive link rail (decorative, no minimum)']
];
let failed = 0;
console.log('contrast (ratio, minimum, result)');
for (const theme of ['light', 'dark'] as const) {
	const t = tokens(theme);
	for (const [fg, bg, min, use] of pairs) {
		const a = t.get(fg);
		const b = t.get(bg);
		if (!a || !b) {
			console.log(`  ${theme} ${fg} on ${bg}: token missing`);
			failed++;
			continue;
		}
		const r = ratio(a, b);
		const ok = r >= min;
		if (!ok) failed++;
		console.log(
			`  ${theme.padEnd(5)} ${r.toFixed(2).padStart(5)}  min ${String(min).padEnd(3)} ${min === 0 ? 'info' : ok ? 'pass' : 'FAIL'}  ${fg} ${a} on ${bg} ${b}  (${use})`
		);
	}
}

const bad = broken.length + failed;
if (bad) process.exitCode = 1;
