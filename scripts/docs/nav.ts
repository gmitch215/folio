import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = { title: string; path?: string; url?: string; description?: string };
type Section = { title: string; pages: Entry[] };
type Group = { title: string; pages: Entry[]; sections?: Section[] };
type Manifest = { groups: Group[] };

type Resolved = {
	entry: Entry;
	group: string;
	kind: 'guide' | 'api' | 'anchor' | 'external';
	file: string;
	hash: string;
};

const GITHUB = 'https://github.com/gmitch215/folio';
const out = process.argv[2] ?? 'typedoc';
const manifestPath = process.argv[3] ?? 'docs/nav.json';

// the name typedoc gives a guide: docs/a/b.md becomes documents/docs_a_b.html, README.md the root page
function resolve(entry: Entry, group: string): Resolved {
	if (entry.url) return { entry, group, kind: 'external', file: entry.url, hash: '' };
	if (!entry.path) throw new Error(`nav entry "${entry.title}" has neither path nor url`);
	const [path = '', hash = ''] = entry.path.split('#');
	if (path === 'api') return { entry, group, kind: 'api', file: 'modules.html', hash };
	const file =
		path === 'README.md'
			? 'index.html'
			: `documents/${path.replace(/\.md$/, '').replaceAll('/', '_')}.html`;
	return { entry, group, kind: hash ? 'anchor' : 'guide', file, hash };
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const flat: Resolved[] = [];
for (const group of manifest.groups) {
	for (const entry of group.pages) flat.push(resolve(entry, group.title));
	for (const section of group.sections ?? [])
		for (const entry of section.pages) flat.push(resolve(entry, group.title));
}
const guides = flat.filter((r) => r.kind === 'guide');
const guideFiles = new Set(guides.map((r) => r.file));

const rendered = readdirSync(join(out, 'documents')).map((f) => `documents/${f}`);
const unlisted = rendered.filter((f) => f.endsWith('.html') && !guideFiles.has(f));
if (unlisted.length) throw new Error(`pages missing from ${manifestPath}: ${unlisted.join(', ')}`);
const absent = guides.filter((r) => r.file !== 'index.html' && !rendered.includes(r.file));
if (absent.length)
	throw new Error(
		`${manifestPath} lists pages TypeDoc did not render: ${absent.map((r) => r.file)}`
	);

const esc = (s: string) =>
	s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

function must(html: string, re: RegExp, file: string, what: string): RegExpMatchArray {
	const m = html.match(re);
	if (!m) throw new Error(`${file}: TypeDoc anchor missing: ${what}`);
	return m;
}

function replaceOnce(html: string, from: string | RegExp, to: string, file: string, what: string) {
	const hit = typeof from === 'string' ? html.includes(from) : from.test(html);
	if (!hit) throw new Error(`${file}: TypeDoc anchor missing: ${what}`);
	return html.replace(from, () => to);
}

function sidebar(root: string, current: Resolved) {
	const link = (r: Resolved) => {
		if (r.kind === 'external')
			return `<a href="${esc(r.file)}" class="docs-ext" rel="noopener">${esc(r.entry.title)}</a>`;
		const here = r.file === current.file && !r.hash;
		const href = `${root}${r.file}${r.hash ? `#${r.hash}` : ''}`;
		return `<a href="${esc(href)}"${here ? ' aria-current="page"' : ''}>${esc(r.entry.title)}</a>`;
	};
	const list = (rs: Resolved[]) => `<ul>${rs.map((r) => `<li>${link(r)}</li>`).join('')}</ul>`;
	const groups = manifest.groups.map((g, gi) => {
		const rs = flat.filter((r) => r.group === g.title);
		const open = rs.some((r) => r.file === current.file && !r.hash && r.kind === 'guide');
		let body = list(flat.filter((r) => g.pages.includes(r.entry)));
		(g.sections ?? []).forEach((s, si) => {
			const id = `docs-section-${gi}-${si}`;
			body += `<p class="docs-section" id="${id}">${esc(s.title)}</p>`;
			body += list(flat.filter((r) => s.pages.includes(r.entry))).replace(
				'<ul>',
				`<ul aria-labelledby="${id}">`
			);
		});
		return `<details class="docs-group" data-group="${esc(g.title)}"${open ? ' open' : ''}><summary>${esc(g.title)}</summary>${body}</details>`;
	});
	return (
		`<div class="docs-sidebar" id="docs-sidebar" popover>` +
		`<div class="docs-sidebar-head"><span>Documentation</span>` +
		`<button type="button" class="docs-close" popovertarget="docs-sidebar" popovertargetaction="hide">Close</button></div>` +
		`<nav class="docs-nav" aria-label="Documentation">${groups.join('')}</nav>` +
		`<a class="docs-side-gh" href="${GITHUB}">GitHub</a></div>\n`
	);
}

// typedoc keeps an emoji in a heading id and github drops it but keeps the hyphen after it, so a
// readme link like #-install works on both once the site ids follow github
function githubIds(html: string, file: string) {
	const renames = new Map<string, string>();
	for (const [, id = ''] of html.matchAll(/<h[1-6] id="([^"]+)"/g)) {
		const plain = id.replace(/[\p{Extended_Pictographic}‍️]/gu, '');
		if (plain !== id) renames.set(id, plain);
	}
	const taken = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? ''));
	const targets = [...renames.values()];
	for (const [from, to] of renames) {
		if (taken.has(to) || targets.indexOf(to) !== targets.lastIndexOf(to))
			throw new Error(
				`${file}: heading ids ${from} and ${to} collide once the emoji is dropped`
			);
		html = html.replaceAll(`id="${from}"`, `id="${to}"`);
		html = html.replaceAll(`href="#${from}"`, `href="#${to}"`);
	}
	return html;
}

function outline(content: string) {
	const items = [
		...content.matchAll(
			/<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<a href="#[^"]*" aria-label="Permalink"/g
		)
	];
	if (!items.length) return '';
	const lis = items.map(
		([, level, id, text]) =>
			`<li class="docs-toc-h${level}"><a href="#${id}">${(text ?? '').replace(/<[^>]+>/g, '')}</a></li>`
	);
	return (
		`<nav class="docs-toc" aria-labelledby="docs-toc-title"><p id="docs-toc-title">On this page</p>` +
		`<ul>${lis.join('')}</ul></nav>`
	);
}

function pager(root: string, current: Resolved) {
	const i = guides.findIndex((r) => r.file === current.file);
	const cell = (r: Resolved | undefined, rel: 'prev' | 'next') => {
		if (!r) return '';
		const label = rel === 'prev' ? 'Previous' : 'Next';
		const desc = r.entry.description
			? `<span class="docs-pager-desc">${esc(r.entry.description)}</span>`
			: '';
		return `<a rel="${rel}" class="docs-pager-${rel}" href="${root}${r.file}"><span class="docs-pager-label">${label}</span><span class="docs-pager-title">${esc(r.entry.title)}</span>${desc}</a>`;
	};
	return `<nav class="docs-pager" aria-label="Previous and next pages">${cell(guides[i - 1], 'prev')}${cell(guides[i + 1], 'next')}</nav>`;
}

function toolbar(html: string, file: string, guide: boolean, root: string) {
	const title = must(html, /<a href="([^"]*)" class="title">([^<]*)<\/a>/, file, 'toolbar title');
	const [name = '', version = ''] = (title[2] ?? '').split(' - ');
	html = html.replace(
		title[0],
		`<a href="${title[1]}" class="title">${esc(name)} <span class="docs-version">${esc(version)}</span></a>`
	);
	html = replaceOnce(html, '<div id="tsd-toolbar-links"></div>', '', file, 'toolbar links');
	const trigger = must(
		html,
		/<button id="tsd-search-trigger" class="tsd-widget" aria-label="Search">(<svg[\s\S]*?<\/svg>)<\/button>/,
		file,
		'search trigger'
	);
	const theme =
		`<button type="button" class="docs-theme" id="docs-theme" hidden>` +
		`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>` +
		`<span class="docs-sr">Theme</span></button>`;
	html = html.replace(
		trigger[0],
		`<button id="tsd-search-trigger" class="tsd-widget docs-search" type="button">${trigger[1]}<span>Search the docs</span><kbd aria-hidden="true">/</kbd></button>` +
			`<a class="docs-github" href="${GITHUB}">GitHub</a>${theme}`
	);
	if (guide) {
		html = replaceOnce(
			html,
			/<a href="#" class="tsd-widget menu" id="tsd-toolbar-menu-trigger"[\s\S]*?<\/a>(?=<\/div><\/header>)/,
			'',
			file,
			'menu trigger'
		);
		html = replaceOnce(
			html,
			'<div class="tsd-toolbar-contents container">',
			`<div class="tsd-toolbar-contents container"><button type="button" class="docs-menu" popovertarget="docs-sidebar">Menu</button>`,
			file,
			'toolbar contents'
		);
	}
	return html;
}

function rewrite(rel: string, html: string) {
	const guide = rel === 'index.html' || guideFiles.has(rel);
	const current = flat.find((r) => r.file === rel && r.kind === 'guide');
	if (guide && !current) throw new Error(`${rel}: guide page without a manifest entry`);
	const root = '../'.repeat(rel.split('/').length - 1);

	html = replaceOnce(
		html,
		/<body>/,
		`<body class="${guide ? 'docs-guide' : 'docs-api'}">`,
		rel,
		'body'
	);
	html = replaceOnce(
		html,
		'<header class="tsd-page-toolbar">',
		`<a class="docs-skip" href="#docs-main">Skip to content</a>\n<header class="tsd-page-toolbar">`,
		rel,
		'toolbar'
	);
	html = toolbar(html, rel, guide, root);
	html = replaceOnce(
		html,
		/<link rel="icon" href="[^"]*favicon\.ico"\/>/,
		`<link rel="icon" href="${root}assets/favicon.ico" sizes="any"/>` +
			`<link rel="icon" type="image/png" sizes="128x128" href="${root}assets/favicon_128.png"/>` +
			`<link rel="apple-touch-icon" href="${root}assets/favicon.png"/>`,
		rel,
		'favicon'
	);
	html = replaceOnce(
		html,
		'<div class="col-content">',
		'<main class="col-content" id="docs-main" tabindex="-1">',
		rel,
		'col-content'
	);

	if (!guide || !current) {
		return replaceOnce(
			html,
			'</div>\n<div class="col-sidebar">',
			'</main>\n<div class="col-sidebar">',
			rel,
			'col-content end'
		);
	}

	// typedoc hides the page until navigation.js builds the API tree, which guide pages do not have
	html = replaceOnce(
		html,
		/<script>document\.documentElement\.dataset\.theme[^<]*<\/script>/,
		`<script>try{document.documentElement.dataset.theme=localStorage.getItem("tsd-theme")||"os"}catch(e){document.documentElement.dataset.theme="os"}</script>`,
		rel,
		'theme script'
	);
	html = replaceOnce(
		html,
		/<script async src="[^"]*navigation\.js" id="tsd-nav-script"><\/script>/,
		'',
		rel,
		'navigation script'
	);
	if (rel !== 'index.html') {
		const suffix = must(html, /<title>[^<]*\| ([^<]*)<\/title>/, rel, 'title')[1];
		html = html.replace(
			/<title>[^<]*<\/title>/,
			`<title>${esc(current.entry.title)} | ${suffix}</title>`
		);
	}

	html = replaceOnce(
		html,
		'<div class="container container-main">\n',
		`<div class="container container-main">\n${sidebar(root, current)}`,
		rel,
		'container'
	);
	html = replaceOnce(
		html,
		/<div class="tsd-page-title">[\s\S]*?<\/div>/,
		rel === 'index.html' ? '' : `<p class="docs-eyebrow">${esc(current.group)}</p>`,
		rel,
		'page title'
	);

	html = githubIds(html, rel);
	const panel = must(
		html,
		/<div class="tsd-panel tsd-typography">([\s\S]*)<\/div>\n<div class="col-sidebar">/,
		rel,
		'content panel'
	);
	const toc = outline(panel[1] ?? '');
	html = replaceOnce(
		html,
		'</div>\n<div class="col-sidebar">',
		`${pager(root, current)}</main>\n<div class="col-sidebar">`,
		rel,
		'col-content end'
	);
	return replaceOnce(
		html,
		/<div class="col-sidebar">[\s\S]*?<\/nav><\/div><\/div>(?=<\/div><footer>)/,
		toc,
		rel,
		'col-sidebar'
	);
}

for (const icon of ['favicon.png', 'favicon_128.png'])
	copyFileSync(join('docs', icon), join(out, 'assets', icon));

let changed = 0;
let skipped = 0;
for (const rel of readdirSync(out, { recursive: true }) as string[]) {
	const path = rel.replaceAll('\\', '/');
	if (!path.endsWith('.html') || path.startsWith('assets/') || path.startsWith('media/'))
		continue;
	const file = join(out, path);
	const html = readFileSync(file, 'utf8');
	if (/<body class="docs-/.test(html)) {
		skipped++;
		continue;
	}
	writeFileSync(file, rewrite(path, html));
	changed++;
}
console.log(`nav: ${changed} pages rewritten, ${skipped} already done, ${guides.length} guides`);
