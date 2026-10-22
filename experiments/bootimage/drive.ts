import { call, type Meter } from '../consumer/drive.ts';
import { sequence, type Variant } from './plan.ts';

type Save = (file: string, value: unknown) => Promise<void>;
type Log = (stage: string, extra?: object) => void;

/** Runs the variant's fixed sequence once; a failed request is recorded and the sequence goes on. */
export async function runBootImage(
	url: string,
	secret: string,
	variant: Variant,
	save: Save,
	log: Log,
	meter: () => Promise<Meter>
) {
	const steps: Record<string, unknown>[] = [];
	for (const step of sequence(variant)) {
		let entry: Record<string, unknown>;
		try {
			const { status, wallMs, body } = await call(
				`${url}${step.path}`,
				secret,
				'GET',
				120000
			);
			entry = { ...step, status, wallMs, body: body.slice(0, 4000) };
		} catch (error) {
			entry = { ...step, error: String(error) };
		}
		steps.push(entry);
		log('bootimage', { label: step.label, status: entry.status, wallMs: entry.wallMs });
		if (steps.length === 1 || steps.length === sequence(variant).length)
			log('meter', await meter());
	}
	await save('steps.json', steps);
	return steps;
}
