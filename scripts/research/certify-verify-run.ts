import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream, type StreamCertificate } from '../../src/certify.ts';
import { buildMiniz, buildOutputSubjects, buildSubjects } from './affine-build.ts';
import { mutants } from './certify-verify-mutants.ts';
import { verifyCertificate, type VerifyOptions } from './certify-verify.ts';

// runs the independent verifier over the checker's accepted certificates and over their mutants
// usage: certify-verify-run.ts subjects
//        certify-verify-run.ts redteam DIRECTORY SHARD COUNT [full] [EVERY]
//        certify-verify-run.ts mutants [NAME...]
// every line printed is one JSON record; mutants exits 1 on a SURPRISE, a bare run exits 2

const REDUCED: VerifyOptions = { full: 24, big: [], some: [1, 2, 3, 16, 17, 33] };

function subjectModules(): Map<string, { bytes: Uint8Array; entry: string }> {
	const paths: Record<string, string> = { ...buildSubjects(), ...buildOutputSubjects() };
	const miniz = buildMiniz();
	if (miniz) paths['miniz-crc32'] = miniz;
	const out = new Map<string, { bytes: Uint8Array; entry: string }>();
	for (const name of [
		'crc32c',
		'crc16',
		'crc64',
		'poly31',
		'lcg',
		'miniz-crc32',
		'adler32',
		'xlcg',
		'xshift',
		'xsbox',
		'xfeed'
	]) {
		const path = paths[name];
		if (!path) continue;
		const bytes = new Uint8Array(readFileSync(path));
		const entry =
			name === 'miniz-crc32'
				? Object.keys(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports).find(
						(e) => e !== 'memory'
					)!
				: name;
		out.set(name, { bytes, entry });
	}
	return out;
}

const print = (o: object) => console.log(JSON.stringify(o));
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'subjects') {
	for (const [name, { bytes, entry }] of subjectModules()) {
		const cert = certifyStream(bytes, entry);
		if (cert.kind !== 'certificate') {
			print({ name, checker: 'refused', reason: cert.reason });
			continue;
		}
		const t = performance.now();
		const v = verifyCertificate(bytes, cert);
		print({
			name,
			ring: cert.ring,
			output: !!cert.output,
			agrees: v.ok,
			reason: v.reason,
			cases: v.cases,
			ms: Math.round(performance.now() - t)
		});
	}
} else if (mode === 'redteam') {
	const [dir, shard, count, depth, every] = rest as [string, string, string, string?, string?];
	const options = depth === 'full' ? {} : REDUCED;
	const step = Number(every ?? 1);
	const files = ['build', 'clang']
		.flatMap((d) => {
			try {
				return readdirSync(join(dir, d))
					.filter((f) => f.endsWith('.wasm'))
					.sort()
					.map((f) => join(dir, d, f));
			} catch {
				return [];
			}
		})
		.filter((_, i) => i % step === 0)
		.filter((_, i) => i % Number(count) === Number(shard));
	for (const file of files) {
		const bytes = new Uint8Array(readFileSync(file));
		const cert = certifyStream(bytes, 'update');
		if (cert.kind !== 'certificate') {
			print({ file, checker: 'refused' });
			continue;
		}
		const t = performance.now();
		const v = verifyCertificate(bytes, cert, options);
		print({
			file,
			ring: cert.ring,
			output: !!cert.output,
			agrees: v.ok,
			reason: v.reason,
			cases: v.cases,
			ms: Math.round(performance.now() - t)
		});
	}
} else if (mode === 'mutants') {
	const modules = subjectModules();
	const names = rest.length ? rest : [...modules.keys()];
	const total = { mutants: 0, changes: 0, rejected: 0, same: 0, acceptedSame: 0 };
	let surprises = 0;
	for (const name of names) {
		const { bytes, entry } = modules.get(name)!;
		const cert = certifyStream(bytes, entry) as StreamCertificate;
		for (const m of mutants(cert)) {
			const v = verifyCertificate(bytes, m.cert, REDUCED);
			total.mutants++;
			if (m.claim === 'changes') {
				total.changes++;
				if (!v.ok) total.rejected++;
			} else {
				total.same++;
				if (v.ok) total.acceptedSame++;
			}
			const survived = (m.claim === 'changes' && v.ok) || (m.claim === 'same' && !v.ok);
			print({
				name,
				id: m.id,
				field: m.field,
				claim: m.claim,
				verifier: v.ok ? 'accepts' : 'rejects',
				reason: v.reason,
				...(survived ? { SURPRISE: true } : {})
			});
			if (survived) surprises++;
		}
	}
	print({ total });
	if (surprises) process.exitCode = 1;
} else {
	console.error(
		'usage: certify-verify-run.ts subjects | redteam DIR SHARD COUNT [full] [EVERY]' +
			' | mutants [NAME...]'
	);
	process.exit(2);
}
