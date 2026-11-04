import { readFileSync } from 'node:fs';
import { certifyStream } from '../../../src/certify.ts';
import { judge } from './lib.ts';

// usage: node one.ts certify|judge FILE; one module per process so a parent can kill a wasm call
// that never returns, and the row goes to stdout as JSON
const [mode, file] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(file!));

if (mode === 'certify') {
	const r = certifyStream(bytes, 'update');
	process.stdout.write(
		JSON.stringify(
			r.kind === 'certificate'
				? { kind: 'certificate', ring: r.ring, bits: r.bits }
				: { kind: 'refusal', reason: r.reason.slice(0, 300) }
		)
	);
} else {
	const j = judge(bytes);
	process.stdout.write(
		JSON.stringify({
			status: j.status,
			reason: j.reason,
			wrong: j.wrong,
			composes: j.composes,
			failure: j.failure ?? null,
			checks: j.checks,
			skipped: j.skipped,
			combos: j.combos,
			ms: Math.round(j.ms),
			ring: j.cert?.ring ?? null,
			bits: j.cert?.bits ?? null,
			zeroLength: j.cert?.zeroLength ?? null,
			exclusions: j.cert?.exclusions ?? null,
			operator: j.cert
				? Array.isArray(j.cert.model.operator)
					? j.cert.model.operator.map(String)
					: String(j.cert.model.operator)
				: null,
			image: j.cert?.image ?? null,
			initialization: j.cert?.initialization ?? null
		})
	);
}
