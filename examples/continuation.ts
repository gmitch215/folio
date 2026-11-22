import {
	cpuSignal,
	type DurableObjectStorage,
	runSlice,
	type StopReason
} from '../src/continuation.ts';

// Runs the tests/c/continuation.c guest across alarm slices. The module is a wrangler binding:
//   wasm_modules = { GUEST = "build/continuation.wasm" }
interface Env {
	GUEST: WebAssembly.Module;
}

export class ContinuationObject {
	private readonly storage: DurableObjectStorage;
	private readonly env: Env;
	private instance: WebAssembly.Instance | undefined;

	constructor(ctx: { storage: DurableObjectStorage }, env: Env) {
		this.storage = ctx.storage;
		this.env = env;
	}

	async fetch(): Promise<Response> {
		// far enough ahead; a near-due alarm move outside alarm() can reset the object
		await this.storage.setAlarm(Date.now() + 1000);
		return new Response('started');
	}

	async alarm(): Promise<void> {
		// a new isolate gets a new instance; runSlice restores its memory from the last commit
		const instance = (this.instance ??= new WebAssembly.Instance(this.env.GUEST));
		const memory = instance.exports.memory as WebAssembly.Memory;
		const run = instance.exports.run as (budget: number) => number;
		const getSteps = instance.exports.get_steps as () => number;
		const signal = cpuSignal(instance, memory);
		await runSlice({
			storage: this.storage,
			memory,
			signal,
			run(budget): StopReason {
				if (run(budget)) return 'finished';
				return signal?.raised ? 'signal' : 'budget';
			},
			steps: getSteps
		});
	}
}
