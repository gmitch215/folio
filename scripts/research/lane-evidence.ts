import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The fields of a tail event worth keeping; the rest holds client addresses, headers and locations. */
export function scrubTail(event: any) {
	const url: string | undefined = event?.event?.request?.url;
	let path: string | undefined;
	if (url) {
		const parsed = new URL(url);
		path = `${parsed.pathname}${parsed.search}`;
	}
	return {
		scriptName: event.scriptName,
		outcome: event.outcome,
		executionModel: event.executionModel,
		eventTimestamp: event.eventTimestamp,
		wallTime: event.wallTime,
		cpuTime: event.cpuTime,
		exceptions: event.exceptions,
		logs: event.logs,
		rpcMethod: event.event?.rpcMethod,
		method: event.event?.request?.method,
		path,
		colo: event.event?.request?.cf?.colo,
		status: event.event?.response?.status
	};
}

/** Splits a `wrangler tail --format json` capture, a run of pretty-printed objects, into one scrubbed JSON line each. */
export function tailLines(text: string): string[] {
	return text
		.split(/\n(?=\{\n)/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => JSON.stringify(scrubTail(JSON.parse(chunk))));
}

/** Throws when text carries a workers.dev name or one of the secrets in `secrets`. */
export function assertClean(label: string, text: string, secrets: readonly string[]) {
	if (text.includes('workers.dev')) throw new Error(`${label} names a workers.dev host`);
	if (/authorization|cf-connecting-ip/i.test(text))
		throw new Error(`${label} carries request headers`);
	if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text)) throw new Error(`${label} carries an IP address`);
	for (const secret of secrets)
		if (secret && text.includes(secret)) throw new Error(`${label} carries a credential value`);
}

/**
 * Writes a sanitized study record from one ignored deploy run: raw.jsonl, tail.jsonl, summary.json
 * and environment.json. Account listings and deploy logs stay behind.
 */
export function exportRun(
	runDirectory: string,
	target: string,
	secrets: readonly string[] = [
		process.env.FOLIO_CLOUDFLARE_ACCOUNT_ID ?? '',
		process.env.FOLIO_CLOUDFLARE_API_TOKEN ?? ''
	]
) {
	const read = (name: string) => readFileSync(join(runDirectory, name), 'utf8');
	const maybe = (name: string) =>
		existsSync(join(runDirectory, name)) ? JSON.parse(read(name)) : undefined;
	const tails = readdirSync(runDirectory)
		.filter((name) => name.startsWith('tail-') && name.endsWith('.jsonl'))
		.sort()
		.flatMap((name) => tailLines(read(name)));
	const files: Record<string, string> = {
		'raw.jsonl': read('requests.jsonl'),
		'tail.jsonl': tails.length ? `${tails.join('\n')}\n` : '',
		'summary.json': `${JSON.stringify(JSON.parse(read('summary.json')), null, '\t')}\n`,
		'environment.json': `${JSON.stringify(
			{
				run: maybe('run.json'),
				calibration: maybe('calibration.json'),
				placement: maybe('placement.json')
			},
			null,
			'\t'
		)}\n`
	};
	for (const [name, text] of Object.entries(files)) assertClean(name, text, secrets);
	mkdirSync(target, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text);
	return Object.keys(files);
}

if (import.meta.main) {
	const [run, target] = process.argv.slice(2);
	if (!run || !target)
		throw new Error('usage: lane-evidence.ts <run directory> <target directory>');
	console.log(exportRun(resolve(run), resolve(target)).join('\n'));
}
