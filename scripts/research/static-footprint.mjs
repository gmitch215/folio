// usage: node static-footprint.mjs DIR ; per module, counts of memory stores to constant addresses, global writes,
// indirect calls and imported calls in the text form, to test whether a static feature separates the loops
// whose records share state from the ones whose records do not
import binaryen from 'binaryen';
import { readFileSync, readdirSync } from 'node:fs';

const dir = process.argv[2];
const compact = binaryen.Features.CompactImports;
console.log(
	'| module | functions | stores to constant addresses | global writes | indirect calls | imports called |'
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const file of readdirSync(dir)
	.filter((name) => name.endsWith('.wasm'))
	.sort()) {
	const module = binaryen.readBinary(readFileSync(`${dir}/${file}`));
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const lines = text.split('\n');
	let functions = 0;
	let constantStores = 0;
	let globalWrites = 0;
	let indirect = 0;
	const imports = new Set(
		[...text.matchAll(/\(import "[^"]+" "([^"]+)" \(func (\$[^\s)]+)/g)].map((m) => m[2])
	);
	let importedCalls = 0;
	lines.forEach((line, index) => {
		if (/^\s*\(func /.test(line)) functions++;
		if (/global\.set/.test(line)) globalWrites++;
		if (/call_indirect/.test(line)) indirect++;
		const call = line.match(/\(call (\$[^\s)]+)/);
		if (call && imports.has(call[1])) importedCalls++;
		const store = line.match(/\((?:i32|i64|f32|f64)\.store\d*(?:\s+\S+=\S+)*\s*$/);
		if (store && /^\s*\(i32\.const -?\d+\)/.test(lines[index + 1] ?? '')) constantStores++;
		else if (/\(i32\.store\d*[^\n]*\(i32\.const -?\d+\)\s*$/.test(line)) constantStores++;
	});
	console.log(
		`| ${file.replace('.wasm', '')} | ${functions} | ${constantStores} | ${globalWrites} | ${indirect} | ${importedCalls} |`
	);
}
