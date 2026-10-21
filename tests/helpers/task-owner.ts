import { parentPort, workerData } from 'node:worker_threads';
import { TaskPool, peakConcurrency, type TaskLink } from '../../src/tasks.ts';

const pool = new TaskPool(workerData.links as TaskLink[]);
const results = pool.runSync([
	['sleep', '120'],
	['sleep', '120'],
	['upper', 'owner']
]);

parentPort!.postMessage({
	texts: results.map((result) => result.text()),
	peak: peakConcurrency(pool.drain().slice(0, 2))
});
pool.close();
