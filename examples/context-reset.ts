import { prepareContext } from '@gmitch215/folio/compiler';
import { InstanceCheckpoint } from '@gmitch215/folio/context';
import { readFileSync } from 'node:fs';

// Run independent jobs on one private instance and reset it between them. The checkpoint compares
// every page, so jobs may dirty different pages and nothing is learned from the first run.
const plan = prepareContext(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
if (plan.reasons.length) throw new Error(`create a fresh instance per job: ${plan.reasons}`);

const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const instance = new WebAssembly.Instance(new WebAssembly.Module(plan.bytes as BufferSource), {
	env: { memory }
});
const mix = instance.exports.mix as (address: number, rounds: number) => number;

new Uint32Array(memory.buffer, 1024, 4).set([11, 22, 33, 44]);
const checkpoint = new InstanceCheckpoint(instance, plan);
const initial = new Uint8Array(memory.buffer).slice();

for (const [address, rounds] of [
	[1024, 100],
	[1028, 5000],
	[1036, 7]
] as const) {
	const value = mix(address, rounds);
	const report = checkpoint.restore();
	const clean = Buffer.from(memory.buffer).equals(Buffer.from(initial));
	console.log({ address, value, changedPages: report.changedPages, restored: clean });
}

// growing memory cannot be undone, so a grown context has to be recreated
memory.grow(1);
try {
	checkpoint.restore();
} catch (error) {
	console.log((error as Error).name, '-> create a new context');
}
