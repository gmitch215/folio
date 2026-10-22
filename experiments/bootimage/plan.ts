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
