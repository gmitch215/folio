import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../src/compiler.ts';
import { memoryImports } from '../../src/memory.ts';

const root = new URL('../../', import.meta.url);

const required = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name}`);
	return value;
};

/** Where each consumer's original module lives; the files are read only. */
export const artifacts: Record<string, string> = {
	'kernel-control': fileURLToPath(new URL('build/fixture.wasm', root)),
	get 'process-abi'() {
		return required('FOLIO_PROCESS_ABI');
	},
	get tinyimg() {
		return required('FOLIO_TINYIMG');
	}
};

async function bundle(entry: string) {
	const result = await build({
		entryPoints: [fileURLToPath(new URL(entry, root))],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		logLevel: 'error'
	});
	return result.outputFiles[0]!.text;
}

export interface Asset {
	type: string;
	text?: string;
	base64?: string;
}

/** Builds the page, its lane and one module plus trusted metadata per named consumer. */
export async function consumerAssets(names: string[]) {
	const assets: Record<string, Asset> = {
		'/arena': {
			type: 'text/html',
			text: '<!doctype html><meta charset="utf-8"><title>Folio consumer harness</title><script type="module" src="/harness.js"></script>'
		},
		'/harness.js': {
			type: 'application/javascript',
			text: await bundle('experiments/consumer/harness.ts')
		},
		'/lane.js': {
			type: 'application/javascript',
			text: await bundle('src/browser-worker.ts')
		}
	};
	for (const name of names) {
		const bytes = readFileSync(artifacts[name] ?? '');
		const { loops, native, reasons } = prepare(bytes);
		assets[`/consumer/${name}.wasm`] = {
			type: 'application/wasm',
			base64: Buffer.from(bytes).toString('base64')
		};
		assets[`/consumer/${name}.json`] = {
			type: 'application/json',
			text: JSON.stringify({ loops, native, reasons, memories: memoryImports(bytes) })
		};
	}
	return assets;
}

if (import.meta.main) {
	const names = process.argv.slice(2);
	const selected = names.length ? names : Object.keys(artifacts);
	mkdirSync(new URL('build/', import.meta.url), { recursive: true });
	writeFileSync(
		new URL('build/assets.json', import.meta.url),
		JSON.stringify(await consumerAssets(selected))
	);
	console.log(`experiments/consumer/build/assets.json: ${selected.join(', ')}`);
}
