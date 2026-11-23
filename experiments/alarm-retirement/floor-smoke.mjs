// three L=2 F=15 requests on fresh objects; each must be ok, with actualMs within 1 s of 2 s and about 8 slices
// exit 0 pass; exit 3 when a request reset with the code-updated error (the caller retries once); exit 1 otherwise
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
let other = false;
let codeUpdated = false;
for (let i = 0; i < 3; i++) {
	const res = await fetch(`${base}/?do=smoke-${Date.now()}-${i}&L=2&F=15`);
	const r = await res.json();
	const actualMs = r.body?.actualMs ?? null;
	const slices = r.body?.slices ?? null;
	const ok =
		r.ok === true &&
		actualMs !== null &&
		Math.abs(actualMs - 2000) <= 1000 &&
		slices >= 6 &&
		slices <= 10;
	if (!ok) {
		if (String(r.error ?? '').includes('code was updated')) codeUpdated = true;
		else other = true;
	}
	console.log(
		`smoke ${i} status=${res.status} ok=${r.ok} slices=${slices} actualMs=${actualMs} error=${r.error ?? ''}`
	);
}
if (other) {
	console.log('smoke failed');
	process.exit(1);
}
if (codeUpdated) {
	console.log('smoke hit the code-updated reset');
	process.exit(3);
}
console.log('smoke passed');
