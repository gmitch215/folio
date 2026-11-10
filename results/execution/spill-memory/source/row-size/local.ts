import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Group } from './config.ts';
import { GROUP_CLASSES, GROUP_WORKER, bindingOf } from './config.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const secret = 'local-only';

/** the worker for a group on local workerd, with the colo probe off so nothing leaves the machine */
export async function startLocal(group: Group) {
	const durableObjects = Object.fromEntries(
		GROUP_CLASSES[group].map((c) => [
			bindingOf(group, c),
			{ className: c, useSQLite: true }
		])
	);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: `e1-${group}`,
					modulesRoot: here,
					modules: [{ type: 'ESModule' as const, path: resolve(here, GROUP_WORKER[group]) }],
					compatibilityDate: '2026-10-20',
					bindings: { SECRET: secret, COLO_PROBE: 'off' },
					durableObjects
				}
			]
		})
	);
	const base = 'http://e1.local';
	const fetchImpl = ((input: any, init?: any) =>
		mf.dispatchFetch(String(input), init)) as unknown as typeof fetch;
	return { base, fetchImpl, dispose: () => mf.dispose() };
}
