(() => {
	const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs';
	const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.18.11/dist/';
	const blocks = [...document.querySelectorAll('pre > code.mermaid, pre > code.math')];
	const isMath = (code) => code.classList.contains('math');
	const dark = () =>
		document.documentElement.dataset.theme === 'dark' ||
		(document.documentElement.dataset.theme !== 'light' &&
			matchMedia('(prefers-color-scheme: dark)').matches);
	let count = 0;

	async function draw(code, mermaid, katex) {
		const pre = code.parentElement;
		const view = document.createElement('div');
		view.className = 'docs-render';
		try {
			if (isMath(code))
				katex.render(code.textContent, view, { displayMode: true, throwOnError: true });
			else {
				await mermaid.parse(code.textContent);
				view.innerHTML = (
					await mermaid.render(`docs-mermaid-${count++}`, code.textContent)
				).svg;
			}
			pre.nextElementSibling?.matches('.docs-render') && pre.nextElementSibling.remove();
			pre.after(view);
			pre.hidden = true;
		} catch (error) {
			pre.hidden = false;
			console.warn('docs block left as source', error);
		}
	}

	async function run() {
		const mermaid = blocks.some((code) => !isMath(code))
			? (await import(MERMAID)).default
			: null;
		const katex = blocks.some(isMath) ? (await import(`${KATEX}katex.min.mjs`)).default : null;
		if (katex)
			document.head.append(
				Object.assign(document.createElement('link'), {
					rel: 'stylesheet',
					href: `${KATEX}katex.min.css`
				})
			);
		const render = () => {
			mermaid?.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				suppressErrorRendering: true,
				theme: dark() ? 'dark' : 'default',
				// narrower sequence layout keeps three-participant diagrams at 0.55 scale or better at 390 px
				sequence: { width: 100, diagramMarginX: 20 }
			});
			return Promise.all(blocks.map((code) => draw(code, mermaid, katex)));
		};
		await render();
		new MutationObserver(render).observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
		});
		matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
	}

	if (blocks.length) run().catch((error) => console.warn('docs render unavailable', error));
})();

(() => {
	const root = document.documentElement;
	const OPEN_KEY = 'docs-nav-open';
	const store = {
		get(key) {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		set(key, value) {
			try {
				localStorage.setItem(key, value);
			} catch {}
		}
	};
	const isDark = () =>
		root.dataset.theme === 'dark' ||
		(root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

	const themeButton = document.getElementById('docs-theme');
	if (themeButton) {
		const label = () =>
			themeButton.setAttribute(
				'aria-label',
				`Switch to ${isDark() ? 'light' : 'dark'} theme`
			);
		themeButton.hidden = false;
		label();
		themeButton.addEventListener('click', () => {
			const next = isDark() ? 'light' : 'dark';
			root.dataset.theme = next;
			store.set('tsd-theme', next);
			const select = document.getElementById('tsd-theme');
			if (select) select.value = next;
			label();
		});
		matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
	}

	const sidebar = document.getElementById('docs-sidebar');
	if (sidebar) {
		const groups = [...sidebar.querySelectorAll('details.docs-group')];
		let saved = [];
		try {
			saved = JSON.parse(store.get(OPEN_KEY) ?? '[]');
		} catch {}
		for (const group of groups) {
			if (saved.includes(group.dataset.group)) group.open = true;
			group.addEventListener('toggle', () => {
				const open = groups.filter((g) => g.open).map((g) => g.dataset.group);
				store.set(OPEN_KEY, JSON.stringify(open));
			});
		}

		const current = sidebar.querySelector('a[aria-current="page"]');
		const wide = matchMedia('(min-width: 770px)');
		if (wide.matches && current)
			sidebar.scrollTop = current.offsetTop - sidebar.clientHeight / 2;
		wide.addEventListener('change', () => {
			if (wide.matches && sidebar.hidePopover && sidebar.matches(':popover-open'))
				sidebar.hidePopover();
		});
		sidebar.addEventListener('toggle', (event) => {
			if (event.newState === 'open') (current ?? sidebar.querySelector('a'))?.focus();
		});
	}

	const toc = document.querySelector('.docs-toc');
	if (toc && 'IntersectionObserver' in window) {
		const links = new Map(
			[...toc.querySelectorAll('a[href^="#"]')].map((a) => [
				a.getAttribute('href').slice(1),
				a
			])
		);
		const seen = new Set();
		const mark = () => {
			const heads = [...links.keys()]
				.map((id) => document.getElementById(id))
				.filter(Boolean);
			const active =
				heads.find((h) => seen.has(h.id)) ??
				[...heads].reverse().find((h) => h.getBoundingClientRect().top < 0);
			for (const [id, a] of links)
				active?.id === id
					? a.setAttribute('aria-current', 'location')
					: a.removeAttribute('aria-current');
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries)
					e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
				mark();
			},
			{ rootMargin: '-72px 0px -70% 0px' }
		);
		for (const id of links.keys()) {
			const heading = document.getElementById(id);
			if (heading) observer.observe(heading);
		}
	}
})();
