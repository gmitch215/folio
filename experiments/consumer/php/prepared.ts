import coordinator from '../build/php/coordinator.wasm';
import lane from '../build/php/lane.wasm';
import modules from '../build/php/modules.json' with { type: 'json' };
import tracked from '../build/php/tracked.wasm';
import base, { PhpProbe as Probe } from './worker.ts';

const parts: Record<string, WebAssembly.Module> = { coordinator, lane, tracked };
const described: Record<
	string,
	{ bytes: number; memories: { initial: number; maximum?: number; shared: boolean }[] }
> = modules;

function stubs(name: string, module: WebAssembly.Module) {
	const memory = described[name]?.memories[0];
	const imports: Record<string, Record<string, unknown>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		const namespace = (imports[item.module] ??= {});
		if (item.kind === 'function') namespace[item.name] = () => 0;
		else if (item.kind === 'memory')
			namespace[item.name] = new WebAssembly.Memory({
				initial: memory?.initial ?? 1,
				...(memory?.maximum === undefined ? {} : { maximum: memory.maximum }),
				shared: memory?.shared ?? false
			});
		else if (item.kind === 'table')
			namespace[item.name] = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
		else
			namespace[item.name] = new WebAssembly.Global(
				{ value: 'i32', mutable: item.module === '__folio_control' },
				0
			);
	}
	return imports;
}

export class PhpProbe extends Probe {
	protected override async early(url: URL) {
		if (url.pathname !== '/prepared') return undefined;
		const report: Record<string, unknown> = {};
		const only = url.searchParams.get('part');
		for (const [name, module] of Object.entries(parts)) {
			if (only && only !== name) continue;
			const imported = WebAssembly.Module.imports(module);
			const entry: Record<string, unknown> = {
				bytes: described[name]?.bytes,
				imports: imported.length,
				exports: WebAssembly.Module.exports(module).length
			};
			try {
				const instance = new WebAssembly.Instance(
					module,
					stubs(name, module) as WebAssembly.Imports
				);
				entry.instantiated = Object.keys(instance.exports).length;
			} catch (error: any) {
				entry.error = String(error?.message ?? error).slice(0, 400);
			}
			report[name] = entry;
		}
		return Response.json(report);
	}
}

export default base;
