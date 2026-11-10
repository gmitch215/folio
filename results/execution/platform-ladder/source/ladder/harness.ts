import { appendFile, mkdir } from 'node:fs/promises';
import type { Config, Rung } from './config.ts';
import { RUNGS } from './config.ts';
import { Counters } from './counters.ts';
import { price } from './plan.ts';
import type { Ctx } from './runner.ts';
import { scrub } from './redact.ts';

export interface Options {
	config: Config;
	rungs?: readonly Rung[];
	base: string;
	secret: string;
	fetchImpl?: typeof fetch;
	rawFile: URL;
	run?: string;
	sleep?: (ms: number) => Promise<void>;
	alignMinute?: boolean;
	timeoutMs?: number;
	log?: (line: object) => void;
}

/** raw lines go to the file as they happen; nothing is aggregated before it is written */
export async function makeCtx(o: Options): Promise<Ctx> {
	await mkdir(new URL('./', o.rawFile), { recursive: true });
	const log = o.log ?? ((line) => console.log(JSON.stringify(scrub(line))));
	return {
		config: o.config,
		run: o.run ?? crypto.randomUUID().slice(0, 6),
		base: o.base,
		secret: o.secret,
		fetchImpl: o.fetchImpl ?? fetch,
		counters: new Counters(price(o.config, o.rungs ?? RUNGS).total, o.config.caps, log),
		sink: (record) => appendFile(o.rawFile, JSON.stringify(scrub(record)) + '\n'),
		sleep: o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		alignMinute: o.alignMinute ?? false,
		timeoutMs: o.timeoutMs ?? 130000
	};
}
