import { TaskPool, peakConcurrency, serveTasks } from '@gmitch215/folio/tasks';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

// Independent jobs on private workers, joined in submission order. The caller names the jobs;
// nothing here discovers independence. Each worker shares no state with the owner.
if (isMainThread) {
	const pool = new TaskPool(4);
	const workers: Worker[] = [];
	for (let index = 0; index < pool.size; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(new URL(import.meta.url), {
				workerData: { link },
				transferList: [link.port]
			})
		);
	}
	try {
		const chunks = Array.from({ length: 8 }, (_, index) => `chunk-${index}`.repeat(100_000));
		const results = await pool.run(
			chunks.map((chunk) => ['sha256', chunk] as [string, string])
		);
		results.forEach((result, index) => console.log(index, result.text().slice(0, 16)));
		const records = pool.drain();
		console.log('peak concurrency', peakConcurrency(records));
	} finally {
		pool.close();
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
} else {
	serveTasks(workerData.link, (name, input) => {
		if (name !== 'sha256') throw new Error(`unknown task ${name}`);
		return createHash('sha256').update(input).digest('hex');
	});
}
