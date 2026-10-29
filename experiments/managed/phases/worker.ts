import { DurableObject } from 'cloudflare:workers';
import { decodeFrame, encodeFrame } from '../../../src/frames.ts';
import { FolioLane, ManagedFolio } from '../../../src/managed.ts';
import artifact, { metadata } from '../artifact.ts';

interface Env {
	LANES: DurableObjectNamespace;
	OWNERS: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

type Stub = any;
type Config = { key: string; pages: number; width: number; rounds: number; count: number };
const maximum = 33 * 1048576;
let moduleId: string | undefined;
const ensure = (value: unknown, message: string) => {
	if (!value) throw new Error(message);
};
const identify = (state: DurableObjectState) => ({
	module: (moduleId ??= crypto.randomUUID()),
	object: state.id.toString()
});
const log = (state: DurableObjectState, tag: string, phase: string, extra = {}) =>
	console.log(
		JSON.stringify({ probe: 'folio-phases', tag, phase, ...identify(state), ...extra })
	);

export class PhaseLane extends DurableObject<Env> {
	instance = crypto.randomUUID();
	executor?: FolioLane;
	uses = 0;

	execute(frame: Uint8Array, tag: string) {
		const firstExecutor = !this.executor;
		this.executor ??= new FolioLane(artifact.transactional, {
			initial: 2,
			maximum: 8192
		});
		const result = this.executor.execute(frame);
		log(this.ctx, tag, 'lane', {
			instance: this.instance,
			firstExecutor,
			uses: ++this.uses,
			requestBytes: frame.length,
			responseBytes: result.length
		});
		return result;
	}

	echo(bytes: Uint8Array, tag: string) {
		const { payload } = decodeFrame(bytes, maximum);
		log(this.ctx, tag, 'echo', { requestBytes: bytes.length, payloadBytes: payload.length });
		return {
			bytes: bytes.length,
			first: payload[0],
			last: payload.at(-1),
			...identify(this.ctx)
		};
	}

	close(tag: string) {
		this.executor?.close();
		this.executor = undefined;
		log(this.ctx, tag, 'lane-close');
	}
}

export class PhaseOwner extends DurableObject<Env> {
	instance = crypto.randomUUID();
	pool?: ManagedFolio;
	config?: Config;
	stubs: Stub[] = [];
	expected = new Uint8Array();
	scalar: unknown;
	tag = '';
	frames = 0;
	laneAwaitMs = 0;
	operations = 0;

	async cell(config: Config, serial: boolean, tag: string, direct = false) {
		const rows: Record<string, unknown>[] = [];
		const self: Stub = this.env.OWNERS.get(this.ctx.id);
		const call = async (
			action: string,
			tag: string,
			extra: object,
			invoke: () => Promise<unknown>
		) => {
			const began = performance.now();
			try {
				const result = await invoke();
				rows.push({
					action,
					tag,
					...extra,
					result,
					ownerAwaitMs: performance.now() - began,
					wallMs: null,
					passed: true
				});
				return true;
			} catch (error) {
				rows.push({
					action,
					tag,
					...extra,
					error: String(error),
					ownerAwaitMs: performance.now() - began,
					wallMs: null,
					passed: false
				});
				return false;
			}
		};
		const configured = await call('setup', `${config.key}-setup`, {}, async () =>
			this.setup(config, `${config.key}-setup`)
		);
		try {
			if (configured) {
				for (let iteration = 0; iteration < 4; iteration++) {
					const tag = `${config.key}-op-${iteration}`;
					if (
						!(await call('operation', tag, { iteration }, () =>
							(direct ? this : self).operation(serial, tag)
						))
					)
						break;
				}
				for (const phase of ['copy', 'transport']) {
					const tag = `${config.key}-${phase}`;
					await call('phase', tag, { phase }, () =>
						(direct ? this : self).phaseBytes(
							phase,
							tag,
							Uint8Array.from(new Uint8Array(this.pool!.memory.buffer)),
							config
						)
					);
				}
			}
		} finally {
			await call('close', `${config.key}-close`, {}, () =>
				(direct ? this : self).close(`${config.key}-close`)
			);
		}
		log(this.ctx, tag, 'cell-owner', { instance: this.instance });
		return { rows };
	}

	initialize(memory: WebAssembly.Memory) {
		new Uint8Array(memory.buffer).fill(0);
		const words = new Uint32Array(memory.buffer, 1024, this.config!.count);
		for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
	}

	setup(config: Config, tag: string) {
		ensure(!this.pool, 'owner is already configured');
		ensure([2, 32, 128, 256, 512].includes(config.pages), 'invalid page count');
		ensure([1, 2, 4, 8].includes(config.width), 'invalid lane width');
		ensure(config.count === 64 && config.rounds === 2097152, 'invalid workload');
		this.config = config;
		this.stubs = Array.from({ length: config.width }, (_, i) =>
			this.env.LANES.get(this.env.LANES.idFromName(`${config.key}-${i}`))
		);
		const memory = new WebAssembly.Memory({
			initial: config.pages,
			maximum: 8192,
			shared: true
		});
		this.pool = new ManagedFolio(artifact, {
			memory,
			lanes: this.stubs.map((stub) => ({
				execute: async (frame: Uint8Array) => {
					this.frames++;
					const began = performance.now();
					try {
						return await stub.execute(frame, this.tag);
					} finally {
						this.laneAwaitMs += performance.now() - began;
					}
				},
				close: async () => {
					await stub.close(this.tag);
				}
			}))
		});
		const expected = new WebAssembly.Memory({
			initial: config.pages,
			maximum: 8192,
			shared: true
		});
		const native = new WebAssembly.Instance(artifact.original, { env: { memory: expected } });
		this.initialize(expected);
		this.scalar = (native.exports.main as CallableFunction)(1024, config.count, config.rounds);
		this.expected = Uint8Array.from(new Uint8Array(expected.buffer));
		log(this.ctx, tag, 'setup', { config, ...metadata, instance: this.instance });
		return {
			instance: this.instance,
			...identify(this.ctx),
			sourceSha256: metadata.sourceSha256,
			jspi: typeof (WebAssembly as any).Suspending === 'function',
			configured: true
		};
	}

	async operation(serial: boolean, tag: string) {
		if (!this.pool || !this.config)
			log(this.ctx, tag, 'missing-owner', { instance: this.instance });
		ensure(this.pool && this.config, 'owner state is absent; setup is required');
		this.tag = tag;
		this.frames = 0;
		this.laneAwaitMs = 0;
		this.initialize(this.pool!.memory);
		const began = performance.now();
		const report = await this.pool!.run(
			'main',
			[1024, this.config!.count, this.config!.rounds],
			{ parallel: serial ? 'off' : 'auto' }
		);
		const runAwaitMs = performance.now() - began;
		ensure(report.values[0] === this.scalar, 'scalar differs');
		const bytes = new Uint8Array(this.pool!.memory.buffer);
		ensure(bytes.length === this.expected.length, 'memory size differs');
		for (let i = 0; i < bytes.length; i++)
			ensure(bytes[i] === this.expected[i], `memory differs at ${i}`);
		const result = {
			instance: this.instance,
			...identify(this.ctx),
			firstPoolOperation: this.operations++ === 0,
			report,
			frames: this.frames,
			summedLaneAwaitMs: this.laneAwaitMs,
			runAwaitMs,
			exact: true,
			checkedBytes: bytes.length,
			diagnostics: this.pool!.diagnostics
		};
		log(this.ctx, tag, 'operation', { serial, frames: this.frames, instance: this.instance });
		return result;
	}

	async phase(phase: string, tag: string) {
		ensure(this.pool && this.config, 'owner state is absent; setup is required');
		const bytes = Uint8Array.from(new Uint8Array(this.pool!.memory.buffer));
		return this.phaseBytes(phase, tag, bytes, this.config!);
	}

	async phaseBytes(phase: string, tag: string, bytes: Uint8Array<ArrayBuffer>, config: Config) {
		const stubs: Stub[] = Array.from({ length: config.width }, (_, index) =>
			this.env.LANES.get(this.env.LANES.idFromName(`${config.key}-${index}`))
		);
		let detail: unknown;
		if (phase === 'copy') {
			let checksum = 0;
			for (let repeat = 0; repeat < 16; repeat++) {
				const frame = encodeFrame({ repeat }, bytes, maximum);
				const decoded = decodeFrame(frame, maximum);
				checksum += decoded.payload.length;
			}
			detail = { copies: 16, payloadBytes: bytes.length * 16, checksum };
		} else if (phase === 'transport') {
			const frame = encodeFrame({ tag }, bytes, maximum);
			const began = performance.now();
			detail = {
				responses: await Promise.all(stubs.map((stub) => stub.echo(frame, tag))),
				awaitMs: performance.now() - began,
				frames: stubs.length,
				bytes: frame.length * stubs.length
			};
		} else throw new Error('unknown phase');
		log(this.ctx, tag, phase);
		return { ...identify(this.ctx), detail };
	}

	async close(tag: string) {
		this.tag = tag;
		await this.pool?.close();
		this.pool = undefined;
		this.expected = new Uint8Array();
		log(this.ctx, tag, 'close');
		return { closed: true, ...identify(this.ctx) };
	}
}

export default {
	async fetch(request, env) {
		if (
			!env.PROBE_TOKEN ||
			request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`
		)
			return new Response('Unauthorized', { status: 401 });
		try {
			const input = (await request.json()) as {
				action: string;
				key: string;
				tag: string;
				config: Config;
				serial: boolean;
				phase: string;
				pages: number;
				width: number;
			};
			ensure(/^[a-z0-9-]{1,100}$/.test(input.key), 'invalid owner key');
			const owner: Stub = env.OWNERS.get(env.OWNERS.idFromName(input.key));
			const began = performance.now();
			let result: unknown;
			if (input.action === 'direct')
				result = await owner.cell(input.config, input.serial, input.tag, true);
			else if (input.action === 'reentrant')
				result = await owner.cell(input.config, input.serial, input.tag);
			else if (input.action === 'cell') {
				const rows: Record<string, unknown>[] = [];
				const call = async (
					action: string,
					tag: string,
					extra: object,
					invoke: () => Promise<unknown>
				) => {
					const began = performance.now();
					try {
						const result = await invoke();
						rows.push({
							action,
							tag,
							...extra,
							result,
							ownerAwaitMs: performance.now() - began,
							wallMs: null,
							passed: true
						});
						return true;
					} catch (error) {
						rows.push({
							action,
							tag,
							...extra,
							error: String(error),
							ownerAwaitMs: performance.now() - began,
							wallMs: null,
							passed: false
						});
						return false;
					}
				};
				const setup = await call('setup', `${input.key}-setup`, {}, () =>
					owner.setup(input.config, `${input.key}-setup`)
				);
				try {
					if (setup) {
						for (let iteration = 0; iteration < 4; iteration++) {
							const tag = `${input.key}-op-${iteration}`;
							if (
								!(await call('operation', tag, { iteration }, () =>
									owner.operation(input.serial, tag)
								))
							)
								break;
						}
						for (const phase of ['copy', 'transport']) {
							const tag = `${input.key}-${phase}`;
							await call('phase', tag, { phase }, () => owner.phase(phase, tag));
						}
					}
				} finally {
					await call('close', `${input.key}-close`, {}, () =>
						owner.close(`${input.key}-close`)
					);
				}
				result = { rows };
			} else if (input.action === 'setup')
				result = await owner.setup(input.config, input.tag);
			else if (input.action === 'operation')
				result = await owner.operation(input.serial, input.tag);
			else if (input.action === 'phase') result = await owner.phase(input.phase, input.tag);
			else if (input.action === 'close') result = await owner.close(input.tag);
			else throw new Error('unknown action');
			log({ id: { toString: () => 'entry' } } as DurableObjectState, input.tag, 'entry');
			return Response.json({ passed: true, result, ownerAwaitMs: performance.now() - began });
		} catch (error) {
			return Response.json({ passed: false, error: String(error) }, { status: 502 });
		}
	}
} satisfies ExportedHandler<Env>;
