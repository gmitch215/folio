// local reference: the guest run to the job's total steps in one call, no signal
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const guest = new WebAssembly.Module(readFileSync(new URL('build/guest.wasm', here)));
const out = {};
for (const steps of [3000, 30000, 120000]) {
	const memory = new WebAssembly.Memory({ initial: 512, maximum: 512 });
	const { exports } = new WebAssembly.Instance(guest, { env: { memory } });
	const done = exports.run(steps);
	out[steps] = {
		done,
		final: String(exports.get_state()),
		sha: createHash('sha256').update(new Uint8Array(memory.buffer)).digest('hex')
	};
	console.log(JSON.stringify({ steps, done, final: out[steps].final, sha: out[steps].sha }));
}
mkdirSync(new URL('runs/', here), { recursive: true });
writeFileSync(new URL('runs/reference.json', here), `${JSON.stringify(out, null, 2)}\n`);
