export type Variant = 'a' | 'b' | 'c';

export const moduleOf = { a: 'original', b: 'boot', c: 'render' } as const;
export const pagesOf = { original: 1024, boot: 1024, render: 1322 } as const;
export const emptyMiB = [16, 64, 128] as const;
export const maximumPages = 65536;
export const readinessAttempts = 4;

export interface Step {
	label: string;
	group: string;
	path: string;
}

export const isVariant = (value: unknown): value is Variant =>
	value === 'a' || value === 'b' || value === 'c';

/** The fixed request sequence of one deploy: 21 Durable Object requests, one per step. */
export function sequence(variant: Variant): Step[] {
	const steps: Step[] = [];
	const add = (group: string, query: string, obj: string) => {
		const index = steps.length;
		steps.push({ label: `${group}-${index}`, group, path: `${query}&obj=${obj}&i=${index}` });
	};
	const m = moduleOf[variant];
	const count = variant === 'a' ? 4 : 10;
	const inst = (group: string, obj: string, check: boolean) =>
		add(`${m}-${group}`, `/inst?m=${m}&check=${check ? 1 : 0}`, obj);
	inst('warm', 'warm', true);
	for (let index = 0; index < count; index++)
		inst(index === count - 1 ? 'check' : 'fresh', `f${index}`, index === count - 1);
	for (let index = 0; index < count; index++)
		inst(index === count - 1 ? 'check' : 'reused', 'warm', index === count - 1);
	if (variant === 'a')
		for (const mib of emptyMiB) {
			add(`create-${mib}`, `/memory?mode=create&mib=${mib}`, `c${mib}`);
			add(`import-${mib}`, `/memory?mode=import&mib=${mib}`, `i${mib}`);
			add(`own-${mib}-fresh`, `/memory?mode=own&mib=${mib}`, `o${mib}`);
			add(`own-${mib}-reused`, `/memory?mode=own&mib=${mib}`, 'warm');
		}
	return steps;
}

/** Worker requests are the readiness polls plus one per step; each step is one Durable Object request. */
export function requestBound(variant: Variant) {
	const durableObjectRequests = sequence(variant).length;
	return {
		maximumRequests: readinessAttempts + durableObjectRequests,
		maximumDurableObjectRequests: durableObjectRequests,
		sqlCalls: 0,
		expectedCharges: 0
	};
}

export const ballastMiB = 8;
export const ballastMaxSteps = 40;
export const boundaryObjects = 3;
export const meterObjects = 3;
export const meterRequests = 4;

export type Mode = 'startup' | 'memory';

export interface MemoryConfig {
	id: string;
	module: 'original' | 'render';
	pages: number;
}

/** deploy a holds the unmodified module at both memories, deploy c the render module at 1322 pages (82.6 MiB, 86.6 MB) */
export const memoryConfigs: Record<Variant, MemoryConfig[]> = {
	a: [
		{ id: 'a64', module: 'original', pages: 1024 },
		{ id: 'a86', module: 'original', pages: 1322 }
	],
	b: [],
	c: [{ id: 'c86', module: 'render', pages: 1322 }]
};

export const boundaryName = (config: MemoryConfig, index: number) => `bal-${config.id}-${index}`;
export const meterName = (config: MemoryConfig, index: number) => `gbs-${config.id}-${index}`;

export interface Fetched {
	status?: number;
	wallMs?: number;
	body: string;
	error?: string;
}

export type Get = (path: string) => Promise<Fetched>;

const stepsOf = (body: string) => {
	try {
		return JSON.parse(body);
	} catch {
		return {};
	}
};

/**
 * One object per boundary run: instantiate and keep the memory, then one 8 MiB step per request until
 * a request does not answer 200 with the memory still held (the reset), then one request to see the
 * new module. Boundary objects of the configurations alternate, then the instantiate-only objects.
 */
export async function driveMemory(
	variant: Variant,
	get: Get,
	log: (stage: string, extra?: object) => void = () => {},
	maxSteps = ballastMaxSteps
) {
	const configs = memoryConfigs[variant];
	const steps: Record<string, unknown>[] = [];
	const record = async (group: string, path: string) => {
		const label = `${group}-${steps.length}`;
		const full = `${path}&i=${steps.length}`;
		const fetched = await get(full);
		const entry = { label, group, path: full, ...fetched };
		steps.push(entry);
		log('bootimage', { label, status: fetched.status, wallMs: fetched.wallMs });
		return entry;
	};
	for (let index = 0; index < boundaryObjects; index++)
		for (const config of configs) {
			const obj = boundaryName(config, index);
			const first = await record(
				`${config.id}-keep`,
				`/inst?m=${config.module}&pages=${config.pages}&keep=1&obj=${obj}`
			);
			if (first.status !== 200) continue;
			for (let step = 1; step <= maxSteps; step++) {
				const entry = await record(
					`${config.id}-ballast`,
					`/ballast?mib=${ballastMiB}&obj=${obj}`
				);
				const body = stepsOf(entry.body);
				if (entry.status === 200 && body.held === true) continue;
				if (step < maxSteps)
					await record(`${config.id}-after`, `/ballast?mib=${ballastMiB}&obj=${obj}`);
				break;
			}
		}
	for (const config of configs)
		for (let index = 0; index < meterObjects; index++)
			for (let repeat = 0; repeat < meterRequests; repeat++)
				await record(
					`${config.id}-meter`,
					`/inst?m=${config.module}&pages=${config.pages}&obj=${meterName(config, index)}`
				);
	return steps;
}

/** The most one memory-mode deploy can send; the early stop at a reset usually sends fewer. */
export function memoryBound(variant: Variant) {
	const configs = memoryConfigs[variant].length;
	const durableObjectRequests =
		configs * boundaryObjects * (1 + ballastMaxSteps) + configs * meterObjects * meterRequests;
	return {
		maximumRequests: readinessAttempts + durableObjectRequests,
		maximumDurableObjectRequests: durableObjectRequests,
		ballastStepMiB: ballastMiB,
		maximumBallastSteps: ballastMaxSteps,
		sqlCalls: 0,
		expectedCharges: 0
	};
}
