import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { collect } from './run.ts';

export async function runLocal(output?: string) {
	const root = bundle('cloud');
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(root),
			compatibilityDate: '2026-09-23',
			compatibilityFlags: ['nodejs_compat'],
			durableObjects: {
				LANES: { className: 'Lane', useSQLite: true },
				COORDINATORS: { className: 'Coordinator', useSQLite: true }
			}
		})
	);
	try {
		const result = await collect('http://folio.local', {
			fetch: (url, init) =>
				mf.dispatchFetch(url, init as never) as unknown as Promise<Response>,
			count: 1024,
			rounds: 3
		});
		if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
		return result;
	} finally {
		await mf.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main)
	console.log(JSON.stringify((await runLocal(process.argv[2])).summary, null, 2));
