import { Worker } from 'node:worker_threads';
import type { SemiringName, StreamSubject, Summarizer } from './morihata.ts';

const worker = new URL('./morihata-worker.ts', import.meta.url);

// one worker thread per chunk; each opens its own instance of the module
export const workerSummarizer =
	(subject: StreamSubject, semiring: SemiringName): Summarizer =>
	(chunk) =>
		new Promise((resolve, reject) => {
			const thread = new Worker(worker);
			thread.once('message', ([a0, a1]: [string, string]) => {
				void thread.terminate();
				resolve([BigInt(a0), BigInt(a1)]);
			});
			thread.once('error', reject);
			thread.postMessage({ subject, semiring, chunk });
		});
