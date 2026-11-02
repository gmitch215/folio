import binaryen from 'binaryen';
import { readFileSync } from 'node:fs';
import { driverDir } from './corpus-lanes.ts';

// per driver: functions in the call tree of `one` that write a global, which is the shadow stack
// pointer; one such function anywhere in the tree keeps `one` from running as a region
for (const id of process.argv.slice(2)) {
	const module = binaryen.readBinary(new Uint8Array(readFileSync(`${driverDir}/${id}.wasm`)));
	module.setFeatures(binaryen.Features.All);
	const framed = new Set<string>();
	const edges = new Map<string, Set<string>>();
	let current = '';
	for (const line of module.emitText().split('\n')) {
		const entry = line.match(/^ \(func (\$[^ ]+)/);
		if (entry) {
			current = entry[1]!;
			edges.set(current, new Set());
			continue;
		}
		if (/global\.set/.test(line)) framed.add(current);
		const call = line.match(/\(call (\$[^ )]+)/);
		if (call && current) edges.get(current)!.add(call[1]!);
	}
	const tree = new Set<string>();
	const pending = ['$one'];
	for (let name = pending.pop(); name; name = pending.pop()) {
		if (tree.has(name)) continue;
		tree.add(name);
		pending.push(...(edges.get(name) ?? []));
	}
	console.log(
		JSON.stringify({ id, tree: tree.size, framed: [...tree].filter((f) => framed.has(f)) })
	);
}
