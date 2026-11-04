import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../../../src/certify.ts';
import { mulberry } from '../lib.ts';
import { modDir, placed, pointerSpots, resultDir, type Row } from './lib.ts';

// usage: recheck.ts SHARD COUNT SECONDS
// runs the pointer placement checks on every accepted-correct row of results/shard-*.jsonl and
// appends to results/extra-recheck-SHARD.jsonl; exits 1 on a wrong acceptance
const shard = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 100);
const r = mulberry(4242);
const pat = Uint8Array.from({ length: 4096 }, () => Math.floor(r() * 256));

const rows = new Map<string, Row>();
for (const f of readdirSync(resultDir))
	if (/^shard-.*\.jsonl$/.test(f))
		for (const line of readFileSync(join(resultDir, f), 'utf8').split('\n'))
			if (line) rows.set(JSON.parse(line).id, JSON.parse(line));
const todo = [...rows.values()].filter((x) => x.verdict === 'accepted-correct');
const file = join(resultDir, `extra-recheck-${shard}.jsonl`);
const done = new Set<string>();
if (existsSync(file))
	for (const line of readFileSync(file, 'utf8').split('\n'))
		if (line) done.add(JSON.parse(line).id);
const t0 = Date.now();
let ran = 0;
let wrong = 0;
for (const [i, row] of todo.entries()) {
	if (i % count !== shard || done.has(row.id)) continue;
	if (Date.now() - t0 > seconds * 1000) break;
	const bytes = new Uint8Array(readFileSync(join(modDir, `${row.sha256.slice(0, 16)}.wasm`)));
	const cert = certifyStream(bytes, 'update');
	let verdict = 'ok';
	let why = '';
	if (cert.kind === 'certificate') {
		const mod = new WebAssembly.Module(bytes);
		outer: for (const len of [1, 2, 3, 17, 100]) {
			const input = pat.subarray(0, len);
			const want = placed(mod, cert, 1 << 20, input);
			for (const at of pointerSpots(mod, cert, len).spots) {
				try {
					const got = placed(mod, cert, at, input);
					if (got.end !== want.end || (cert.output && got.bytes !== want.bytes)) {
						verdict = 'ACCEPTED-WRONG';
						why = `pointer ${at} len ${len} differs`;
						break outer;
					}
				} catch (e) {
					verdict = 'ACCEPTED-WRONG';
					why = `trap at pointer ${at} len ${len}: ${String(e).slice(0, 50)}`;
					break outer;
				}
			}
		}
	} else {
		verdict = 'no-longer-accepted';
	}
	appendFileSync(file, JSON.stringify({ id: row.id, sha256: row.sha256, verdict, why }) + '\n');
	ran++;
	if (verdict === 'ACCEPTED-WRONG') {
		wrong++;
		console.log('WRONG', row.id, why);
	}
}
console.log(`recheck shard ${shard}: ran ${ran}, wrong ${wrong}, todo ${todo.length}`);
process.exit(wrong ? 1 : 0);
