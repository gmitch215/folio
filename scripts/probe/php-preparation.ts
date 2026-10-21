import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { serialize } from 'node:v8';
import { prepare } from '../../src/compiler.ts';

/** Counts emitted functions independently of Binaryen's internal function list. */
function census(bytes: Uint8Array) {
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	const imported = WebAssembly.Module.imports(module).filter(
		(item) => item.kind === 'function'
	).length;
	let cursor = 8;
	const uint = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	let defined = 0;
	while (cursor < bytes.length) {
		const section = bytes[cursor++]!,
			length = uint(),
			end = cursor + length;
		if (section === 3) defined = uint();
		cursor = end;
	}
	return {
		bytes: bytes.length,
		imported,
		defined,
		total: imported + defined,
		nativeValidated: true
	};
}

const [path, output] = process.argv.slice(2);
if (!path || !output) throw new Error('usage: php-preparation.ts ARTIFACT.wasm OUTPUT.json');
const source = readFileSync(path);
const generated = { helpers: 0, memoryHelpers: 0, outlines: 0 };
const originalRead = binaryen.readBinary;
// Isolated probe instrumentation; no hooks or counters are added to the library's hot path.
binaryen.readBinary = (...args) => {
	const module = originalRead(...args);
	if (args[0].length === source.length) {
		const add = module.addFunction.bind(module);
		module.addFunction = (...parameters) => {
			const [name, , , , body] = parameters;
			if (
				name.startsWith('__folio_control_helper_') ||
				name.startsWith('__folio_control_host_')
			)
				generated.helpers++;
			if (name.startsWith('__folio_inline_')) generated.outlines++;
			if (name.startsWith('__folio_control_helper_')) {
				const block = binaryen.getExpressionInfo(body) as binaryen.BlockInfo;
				const id = block.children?.[1]
					? binaryen.getExpressionId(block.children[1])
					: undefined;
				if (id === binaryen.LoadId || id === binaryen.StoreId) generated.memoryHelpers++;
			}
			return add(...parameters);
		};
	}
	return module;
};
const started = performance.now();
const report: Record<string, unknown> = {
	artifact: basename(path),
	sha256: createHash('sha256').update(source).digest('hex'),
	node: process.version,
	v8: process.versions.v8,
	original: census(source)
};
try {
	const program = prepare(source);
	if (process.argv[4]) writeFileSync(process.argv[4], serialize(program));
	report.preparationMs = performance.now() - started;
	report.generated = generated;
	report.reasons = program.reasons;
	report.control = program.control
		? {
				regions: program.control.regions.length,
				entries: program.control.entries.length,
				coordinator: census(program.control.coordinator),
				worker: census(program.control.workerOriginal),
				tracked: census(program.control.transactional),
				diagnosticCount: program.control.diagnostics.length
			}
		: null;
} catch (error) {
	report.error = String(error);
} finally {
	binaryen.readBinary = originalRead;
}
report.totalMs = performance.now() - started;
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
