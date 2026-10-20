declare module '*.wasm' {
	const bytes: ArrayBuffer;
	export default bytes;
}

declare module '*/probe.js' {
	const source: string;
	export default source;
}
