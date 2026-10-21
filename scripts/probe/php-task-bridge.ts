import { TaskError, TaskPool, serveTasks as serve, type TaskLink } from '../../src/tasks.ts';

// explicit parallel API, not automatic extraction: PHP submits a named function plus serialized
// arguments to a private PHP context in another thread and joins the serialized result.
// The transport is src/tasks.ts; this file adds the PHP shim shapes and the per-task log.
export interface TaskLog {
	id: string;
	worker: number;
	fn: string;
	submitMs: number;
	submitHostMs: number;
	joinStartMs: number;
	joinEndMs: number;
	waitMs: number;
	startMs: number;
	endMs: number;
	cpuMs: number;
	argBytes: number;
	resultBytes: number;
}

const now = () => performance.timeOrigin + performance.now();

/** the owner side: binds submit and join for the PHP shim, spreading tasks over the first `width` servers */
export function ownerBridge(links: TaskLink[]) {
	const pool = new TaskPool(links);
	const submitHost = new Map<string, number>();
	let log: TaskLog[] = [];
	return {
		setWidth(value: number) {
			pool.width = Math.min(value, pool.size);
		},
		drain() {
			const out = log;
			log = [];
			return out;
		},
		submit(json: string) {
			const t0 = now();
			const request = JSON.parse(json) as { fn: string; b64: string };
			const id = pool.submit(request.fn, request.b64);
			submitHost.set(id, now() - t0);
			return id;
		},
		join(id: string) {
			const joinStartMs = now();
			try {
				const result = pool.join(id);
				const record = result.record;
				log.push({
					id,
					worker: record.worker,
					fn: record.name,
					submitMs: record.submitMs,
					submitHostMs: submitHost.get(id) ?? 0,
					joinStartMs,
					joinEndMs: now(),
					waitMs: record.waitMs,
					startMs: record.startMs,
					endMs: record.endMs,
					cpuMs: record.cpuMs ?? 0,
					argBytes: record.inputBytes,
					resultBytes: record.outputBytes
				});
				return JSON.stringify({ ok: true, b64: result.text() });
			} catch (error) {
				if (!(error instanceof TaskError)) throw error;
				return JSON.stringify({ ok: false, b64: error.message });
			} finally {
				submitHost.delete(id);
			}
		}
	};
}

/** the server side: runs each submitted task in this context, one at a time, and replies */
export function serveTasks(
	link: TaskLink,
	run: (code: string) => Promise<string>,
	cpu: () => number
) {
	serve(
		link,
		(name, input) => run(`<?php echo __cfw_task_exec(${JSON.stringify(name)}, '${input}');`),
		{ cpu }
	);
}
