import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// usage: node floor-snap.mjs <before|after>; writes snap-<label>.json with Worker script and namespace names only
const label = process.argv[2];
if (!label) throw new Error('usage: floor-snap.mjs <label>');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('credentials are not set in the environment');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

async function get(path) {
	const res = await fetch(`${base}${path}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(30000)
	});
	const body = await res.json();
	if (!res.ok || !body.success) throw new Error(`${path}: HTTP ${res.status}`);
	return body.result;
}

const scripts = (await get('/workers/scripts')).map((r) => r.id).sort();
const namespaces = (await get('/workers/durable_objects/namespaces?per_page=100'))
	.map((r) => r.name)
	.sort();
const snap = { scripts, namespaces };
writeFileSync(`snap-${label}.json`, `${JSON.stringify(snap, null, 1)}\n`);
const digest = createHash('sha256').update(JSON.stringify(snap)).digest('hex').slice(0, 12);
console.log(
	`${label}: scripts=${scripts.length} namespaces=${namespaces.length} floor_present=${scripts.includes('folio-floor-b-1122') || namespaces.includes('folio-floor-b-1122')} digest=${digest}`
);
