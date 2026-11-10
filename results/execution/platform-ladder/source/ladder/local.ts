import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LADDER_BINDINGS, LADDER_CLASSES, MEM_CLASSES } from './config.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const secret = 'local-only';

export type Group = 'ladder' | 'mem';

/** the worker for a group on local workerd, with the colo probe off so nothing leaves the machine */
export async function startLocal(group: Group) {
	const durableObjects =
		group === 'ladder'
			? Object.fromEntries(
					LADDER_CLASSES.map((c) => [LADDER_BINDINGS[c], { className: c, useSQLite: true }])
				)
			: Object.fromEntries(MEM_CLASSES.map((c) => [c, { className: c, useSQLite: true }]));
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: `e1-${group}`,
					modulesRoot: here,
					modules: [{ type: 'ESModule' as const, path: resolve(here, `worker-${group}.mjs`) }],
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
