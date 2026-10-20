import { existsSync, statSync } from 'node:fs';
import { buildFixtures, fixtures } from '../scripts/build/fixtures.ts';

const mtime = (path: URL) => (existsSync(path) ? statSync(path).mtimeMs : 0);

export default function setup() {
	const stale = fixtures.some(
		({ source, output }) =>
			mtime(new URL(`../build/${output}`, import.meta.url)) <
			mtime(new URL(`./c/${source}`, import.meta.url))
	);
	if (stale) buildFixtures();
}
