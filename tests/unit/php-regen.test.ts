import { expect, test } from 'vitest';
import { drain, pageList, seedCode } from '../../scripts/probe/php-regen.ts';

test('the page list is the front page then one url per created node id', () => {
	expect(pageList([2, 4, 6])).toEqual(['/', '/node/2', '/node/4', '/node/6']);
	expect(pageList([])).toEqual(['/']);
});

test('the seed code creates the requested number of nodes and defines the legacy constants', () => {
	const code = seedCode(7);
	expect(code).toContain('$i <= 7');
	expect(code).toContain("'SAVED_NEW' => 1");
	expect(code).toContain("'type' => 'page'");
});

test('every url renders exactly once whatever the width', async () => {
	const urls = Array.from({ length: 9 }, (_, i) => `/node/${i}`);
	for (const width of [1, 2, 4, 16]) {
		const seen: string[] = [];
		const shares = await drain(urls, width, async (_, url) => {
			seen.push(url);
			await Promise.resolve();
			return url.length;
		});
		expect(shares).toHaveLength(width);
		expect(seen.sort()).toEqual([...urls].sort());
		expect(
			shares
				.flat()
				.map((s) => s.url)
				.sort()
		).toEqual([...urls].sort());
	}
});

test('urls leave the queue in order and a slow worker takes fewer of them', async () => {
	const urls = ['a', 'b', 'c', 'd', 'e', 'f'];
	const order: string[] = [];
	const release: Record<string, () => void> = {};
	const gates = new Map(
		urls.map((url) => [url, new Promise<void>((resolve) => (release[url] = resolve))])
	);
	const run = drain(urls, 2, async (worker, url) => {
		order.push(url);
		if (url === 'a') await gates.get('a');
		return worker;
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	release.a!();
	const shares = await run;
	expect(order.slice(0, 2)).toEqual(['a', 'b']);
	expect(shares[0]!.map((s) => s.url)).toEqual(['a']);
	expect(shares[1]!.map((s) => s.url)).toEqual(['b', 'c', 'd', 'e', 'f']);
});
