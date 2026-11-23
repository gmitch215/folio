// three C=0 requests on fresh objects; each must be ok with zero slices
// exit 0 pass; exit 1 otherwise (the run stops, no retry)
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
let failed = false;
for (let i = 0; i < 3; i++) {
	const res = await fetch(`${base}/?do=smoke-${Date.now()}-${i}&slices=0`);
	const r = await res.json();
	const pass = r.ok === true && r.body?.slices === 0;
	if (!pass) failed = true;
	console.log(
		`smoke ${i} status=${res.status} ok=${r.ok} slices=${r.body?.slices ?? null} actualMs=${r.body?.actualMs ?? null} error=${r.error ?? ''}`
	);
}
if (failed) {
	console.log('smoke failed');
	process.exit(1);
}
console.log('smoke passed');
