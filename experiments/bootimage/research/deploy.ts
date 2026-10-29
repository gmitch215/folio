import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../../../scripts/research/environment.ts';
import { decodeImage } from '../../../src/bake.ts';
import { createApi, credentials, retire, snapshot, spawnWrangler } from '../../lib/cloudflare.ts';
import { parseDeployLog } from '../analyze.ts';

const runtime = resolve(process.argv[2] ?? ''),
	role = process.argv[3] ?? 'delivery';
assert.ok(process.argv[2], 'usage: deploy.ts RUNTIME_DIRECTORY [ROLE]');
const selected = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
assert.equal(selected.label, 'FREE');
const api = createApi(selected),
	nonce = crypto.randomUUID().slice(0, 8),
	directory = resolve(`experiments/bootimage/runs/folio-image-cost-${nonce}`);
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) =>
	writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const baseline = await snapshot(api);
save('baseline.json', baseline);
const subdomain = (await api('/workers/subdomain')).subdomain;
const state = join(runtime, 'state'),
	image = decodeImage(new Uint8Array(readFileSync(join(state, 'image.bin'))));
const meta = JSON.parse(readFileSync(join(state, 'meta.json'), 'utf8'));
const rows: Record<string, unknown>[] = [],
	outcomes: Record<string, unknown>[] = [];
const checksum = (bytes: Uint8Array) => {
	let hash = 2166136261;
	for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
	return hash >>> 0;
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const modes = (process.env.FOLIO_IMAGE_MODES ?? 'original,baked,assets').split(',');
assert.ok(
	modes.length > 0 && modes.every((mode) => ['original', 'baked', 'assets'].includes(mode))
);
for (const mode of modes) {
	const name = `cfw-folio-image-${mode}-${nonce}`,
		work = join(directory, mode);
	mkdirSync(work);
	const artifact =
		mode === 'original'
			? join(runtime, 'build/bootimage/interp/php8.5.tuned.wasm')
			: join(state, mode === 'baked' ? 'image.wasm' : 'probe.wasm');
	const module = new WebAssembly.Module(readFileSync(artifact)),
		memory = new WebAssembly.Memory({
			initial: mode === 'original' ? 1024 : meta.pages,
			maximum: 65536
		});
	const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		imports[item.module] ??= {};
		imports[item.module]![item.name] =
			item.kind === 'memory'
				? memory
				: item.kind === 'global'
					? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
					: () => 0;
	}
	new WebAssembly.Instance(module, imports);
	if (mode === 'assets')
		image.pages.forEach((page, index) =>
			new Uint8Array(memory.buffer).set(
				image.data.subarray(index * 65536, (index + 1) * 65536),
				page * 65536
			)
		);
	const assets = join(work, 'assets');
	mkdirSync(assets);
	const chunks: { file: string; pages: number[] }[] = [];
	if (mode === 'assets')
		for (let index = 0; index < image.pages.length; index += 64) {
			const file = `chunk-${chunks.length}.bin`,
				pages = image.pages.slice(index, index + 64);
			writeFileSync(
				join(assets, file),
				image.data.subarray(index * 65536, (index + pages.length) * 65536)
			);
			chunks.push({ file, pages });
		}
	const metadata = join(work, 'metadata.json');
	writeFileSync(
		metadata,
		JSON.stringify({
			pages: mode === 'original' ? 1024 : meta.pages,
			expectedChecksum: checksum(new Uint8Array(memory.buffer)),
			chunks,
			globals: Object.fromEntries(
				meta.entries.map((entry: string) => [
					entry,
					meta.globals[Number(entry.split('_').at(-1))]
				])
			)
		})
	);
	const token = crypto.randomUUID(),
		config = join(work, 'wrangler.jsonc');
	copyFileSync(artifact, join(work, 'target.wasm'));
	const entry = join(work, 'worker.ts');
	writeFileSync(
		entry,
		readFileSync(resolve('experiments/bootimage/research/worker.ts'), 'utf8')
			.replace("'folio:target'", "'./target.wasm'")
			.replace("'folio:image-meta'", "'./metadata.json'")
	);
	writeFileSync(
		config,
		JSON.stringify(
			{
				name,
				main: entry,
				compatibility_date: '2026-10-20',
				rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
				vars: { MODE: mode, PROBE_TOKEN: token },
				durable_objects: { bindings: [{ name: 'IMAGE', class_name: 'ImageCost' }] },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['ImageCost'] }],
				observability: { enabled: true },
				...(mode === 'assets'
					? { assets: { directory: assets, binding: 'ASSETS', run_worker_first: true } }
					: {})
			},
			null,
			2
		)
	);
	let deployed = false;
	try {
		await spawnWrangler(
			selected,
			['deploy', '--config', config],
			new URL(`file://${join(work, 'deploy.log')}`),
			{ cwd: new URL('../../../', import.meta.url) }
		).done;
		deployed = true;
		const deployment = parseDeployLog(readFileSync(join(work, 'deploy.log'), 'utf8'));
		outcomes.push({
			mode,
			sourceSha256: digest(readFileSync(artifact)),
			sourceBytes: readFileSync(artifact).length,
			deployment
		});
		const origin = `https://${name}.${subdomain}.workers.dev`,
			headers = { authorization: `Bearer ${token}` };
		let ready = false;
		for (let attempt = 0; attempt < 15 && !ready; attempt++) {
			await pause(2000);
			const res = await fetch(`${origin}/ready`, { headers });
			appendFileSync(
				join(directory, 'readiness.jsonl'),
				JSON.stringify({ mode, attempt, status: res.status, body: await res.text() }) + '\n'
			);
			ready = res.ok;
		}
		assert.ok(ready, 'deployment did not become ready');
		for (const group of ['fresh', 'repeat'])
			for (let index = 0; index < 12; index++) {
				const tag = `${mode}-${group}-${index}`,
					object = group === 'fresh' ? `fresh-${index}` : 'reused',
					check = index === 0 || index === 11;
				const start = performance.now(),
					response = await fetch(
						`${origin}/measure?object=${object}&tag=${tag}&check=${Number(check)}`,
						{ headers, signal: AbortSignal.timeout(120000) }
					);
				const text = await response.text(),
					row = {
						mode,
						group,
						index,
						tag,
						at: Date.now(),
						wallMs: performance.now() - start,
						status: response.status,
						body: text
					};
				rows.push(row);
				appendFileSync(join(directory, 'requests.jsonl'), JSON.stringify(row) + '\n');
				if (response.ok && check)
					assert.equal(JSON.parse(text).equal, true, 'memory checksum differs');
			}
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${selected.account}/workers/observability/telemetry/query`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${selected.token}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					queryId: `folio-image-${nonce}-${mode}`,
					view: 'events',
					limit: 2000,
					timeframe: { from: Date.now() - 600000, to: Date.now() },
					parameters: {
						filterCombination: 'and',
						filters: [
							{
								key: '$metadata.service',
								operation: 'eq',
								type: 'string',
								value: name
							}
						]
					}
				})
			}
		);
		save(`${mode}-stored.json`, await response.json());
	} catch (error) {
		outcomes.push({ mode, error: String(error) });
	} finally {
		if (deployed) await retire(api, name, ['ImageCost']);
		else {
			const current = await snapshot(api);
			if (current.scripts.includes(name)) {
				const ownNamespace = await api('/workers/durable_objects/namespaces');
				if (ownNamespace.some((item: any) => item.script === name))
					await retire(api, name, ['ImageCost']);
				else await api(`/workers/scripts/${name}`, { method: 'DELETE' });
			}
		}
		assert.deepEqual(await snapshot(api), baseline, 'account differs from baseline');
	}
}
save('outcomes.json', outcomes);
save('after.json', await snapshot(api));
console.log(
	JSON.stringify({
		role,
		directory: directory.split('/').at(-1),
		operations: rows.length,
		baselineRestored: true
	})
);
