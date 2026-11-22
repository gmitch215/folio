import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// arm -> [source in guests/, output in the arm's build/, wat2wasm flags]
const ARMS: Record<string, [string, string, string[]][]> = {
	signal: [
		['burn.wat', 'burn.wasm', []],
		['jspi.wat', 'jspi.wasm', []]
	],
	durable: [
		['durable-guest.wat', 'guest.wasm', []],
		['hash.wat', 'hash.wasm', ['--enable-multi-memory']],
		['burn.wat', 'burn.wasm', []]
	],
	deferred: [
		['durable-guest.wat', 'guest.wasm', []],
		['hash.wat', 'hash.wasm', ['--enable-multi-memory']]
	],
	life: [['burn.wat', 'burn.wasm', []]]
};

const here = dirname(fileURLToPath(import.meta.url));

for (const [arm, jobs] of Object.entries(ARMS)) {
	const build = join(here, arm, 'build');
	mkdirSync(build, { recursive: true });
	for (const [source, output, flags] of jobs) {
		execFileSync('wat2wasm', [
			...flags,
			join(here, 'guests', source),
			'-o',
			join(build, output)
		]);
	}
}
