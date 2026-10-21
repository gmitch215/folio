/** Minimal dedicated-worker scope, also usable by a host's event bridge. */
export interface BrowserWorkerScope {
	onmessage: ((event: { data: any }) => void) | null;
	postMessage(value: unknown): void;
}

/** Installs the bounded native lane protocol. Attach only compiler-admitted original modules. */
export function installBrowserWorker(scope: BrowserWorkerScope) {
	let instance: WebAssembly.Instance | undefined;
	scope.onmessage = ({ data }) => {
		try {
			let value: unknown;
			if (data.action === 'attach') {
				if (instance) throw new Error('browser worker already attached');
				const memory = data.memory as WebAssembly.Memory;
				if (!(memory.buffer instanceof SharedArrayBuffer))
					throw new Error('shared WebAssembly.Memory required');
				instance = new WebAssembly.Instance(data.module, {
					[data.importModule]: { [data.importName]: memory }
				});
				const words = new Int32Array(memory.buffer);
				value = Atomics.compareExchange(words, 0, data.before, data.after);
			} else if (data.action === 'run') {
				if (!instance) throw new Error('browser worker not attached');
				const call = data.call as { export: string; args: number[] };
				if (!call.args.every((argument) => typeof argument === 'number'))
					throw new TypeError('native lane accepts scalar numeric arguments only');
				(instance.exports[call.export] as CallableFunction)(...call.args);
			} else throw new Error('unknown browser worker action');
			scope.postMessage({ sequence: data.sequence, value });
		} catch (error) {
			scope.postMessage({ sequence: data.sequence, error: String(error) });
		}
	};
}

if (typeof self !== 'undefined' && typeof document === 'undefined')
	installBrowserWorker(self as unknown as BrowserWorkerScope);
