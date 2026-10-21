declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

declare module '*/PhpBase.mjs' {
	export class PhpBase extends EventTarget {
		binary: Promise<unknown>;
		constructor(loader: Promise<{ default: unknown }>, args?: Record<string, unknown>);
		_run(code: string): Promise<unknown>;
	}
}

declare module '*/glue.mjs' {
	const factory: (module?: object) => Promise<unknown>;
	export default factory;
}
