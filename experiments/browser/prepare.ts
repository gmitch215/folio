import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// the worker serves probe.ts to Chromium as text, so it ships as plain JavaScript
export function transpileProbe() {
	const source = readFileSync(new URL('./probe.ts', import.meta.url), 'utf8');
	return ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
	}).outputText;
}

if (import.meta.main) {
	mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
	writeFileSync(new URL('./build/probe.js', import.meta.url), transpileProbe());
	console.log('experiments/browser/build/probe.js');
}
