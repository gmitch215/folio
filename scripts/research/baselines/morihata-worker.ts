import { parentPort } from 'node:worker_threads';
import {
	openStream,
	semiringOf,
	summarize,
	type SemiringName,
	type StreamSubject
} from './morihata.ts';

interface Job {
	subject: StreamSubject;
	semiring: SemiringName;
	chunk: Uint8Array;
}

parentPort!.on('message', (job: Job) => {
	const stream = openStream(job.subject);
	const [a0, a1] = summarize(stream, semiringOf(job.semiring), job.chunk);
	parentPort!.postMessage([a0.toString(), a1.toString()]);
});
