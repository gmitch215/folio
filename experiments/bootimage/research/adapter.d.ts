declare module 'folio:boot-context' {
	export function openContext(
		module: WebAssembly.Module,
		options?: Record<string, unknown>
	): Promise<any>;
	export function heapStore(): Promise<any>;
	export function stubImports(
		module: WebAssembly.Module,
		memory: WebAssembly.Memory
	): WebAssembly.Imports;
}
declare module 'folio:target' {
	const module: WebAssembly.Module;
	export default module;
}
declare module 'folio:image-meta' {
	const metadata: {
		pages: number;
		expectedChecksum: number;
		chunks: { file: string; pages: number[] }[];
		globals: Record<string, number>;
	};
	export default metadata;
}
