import { readFile, writeFile } from 'node:fs/promises';
import { credentials, spawnWrangler, stopTail } from '../lib/cloudflare.ts';
const directory = new URL(process.env.FOLIO_ELASTIC_RUN ?? './runs/', import.meta.url);
const { name } = JSON.parse(await readFile(new URL('./source.json', directory), 'utf8'));
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
const tail = spawnWrangler(
	creds,
	['tail', name, '--format', 'json', '--sampling-rate', '0.99'],
	new URL('./tail-valid.log', directory),
	{ cwd: new URL('../../', import.meta.url) }
);
const started = new Date().toISOString();
await Promise.race([tail.done, new Promise((resolve) => setTimeout(resolve, 90000))]);
await stopTail(tail);
await writeFile(
	new URL('./tail-valid.json', directory),
	JSON.stringify({ started, stopped: new Date().toISOString(), samplingRate: 0.99 }, null, 2) +
		'\n',
	{ flag: 'wx' }
);
console.log('tail complete');
