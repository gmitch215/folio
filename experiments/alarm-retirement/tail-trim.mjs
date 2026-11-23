import { readTail } from './floor-tail.mjs';

// usage: node tail-trim.mjs <tail.jsonl>...   prints one trimmed invocation per line
// keeps the fields the analyzers read; request URLs keep their path and query with the host set to a
// reserved name, so the probe report can still parse them; headers and Durable Object ids are dropped
const READ = /^(req|alarm|entry-error|loop-end) /;
const HOST = /[\w-]+\.[\w-]+\.workers\.dev/g;

const messageOf = (log) =>
	Array.isArray(log.message) ? log.message.join(' ') : String(log.message ?? '');

for (const path of process.argv.slice(2)) {
	for (const e of readTail(path)) {
		const logs = e.logs ?? [];
		const exceptions = e.exceptions ?? [];
		if (!exceptions.length && !logs.some((log) => READ.test(messageOf(log)))) continue;
		const kept = {
			outcome: e.outcome,
			cpuTime: e.cpuTime,
			wallTime: e.wallTime,
			eventTimestamp: e.eventTimestamp,
			executionModel: e.executionModel,
			scriptVersion: e.scriptVersion ? { id: e.scriptVersion.id } : undefined,
			event: e.event?.request
				? { request: { method: e.event.request.method, url: e.event.request.url } }
				: undefined,
			logs: logs.map(({ message, level, timestamp }) => ({ message, level, timestamp })),
			exceptions
		};
		const text = JSON.stringify(kept).replace(HOST, 'worker.invalid');
		console.log(text);
	}
}
