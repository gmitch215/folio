import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Candidate {
	id: string;
	project: string;
	build: 'ok' | 'failed';
	native: 'equal' | 'mismatch' | 'not-run';
}

export interface Draw {
	seed: string;
	cap: number;
	drawn: string[];
	notDrawn: { id: string; reason: string }[];
	projects: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// sfc32 seeded from the first four words of sha256(seed)
function generator(seed: string): () => number {
	const digest = sha256(seed);
	let a = digest.readUInt32BE(0);
	let b = digest.readUInt32BE(4);
	let c = digest.readUInt32BE(8);
	let d = digest.readUInt32BE(12);
	return () => {
		const t = (((a + b) >>> 0) + d) >>> 0;
		d = (d + 1) >>> 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) >>> 0;
		c = ((c << 21) | (c >>> 11)) >>> 0;
		c = (c + t) >>> 0;
		return t / 4294967296;
	};
}

const byId = (left: { id: string }, right: { id: string }) =>
	left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export function draw(candidates: Candidate[], seed: string, cap: number): Draw {
	const next = generator(seed);
	const notDrawn: Draw['notDrawn'] = [];
	const pool = new Map<string, Candidate[]>();
	for (const candidate of [...candidates].sort(byId)) {
		if (candidate.build !== 'ok') notDrawn.push({ id: candidate.id, reason: 'build-failed' });
		else if (candidate.native !== 'equal')
			notDrawn.push({ id: candidate.id, reason: 'native-not-equal' });
		else pool.set(candidate.project, [...(pool.get(candidate.project) ?? []), candidate]);
	}
	const drawn: string[] = [];
	for (const project of [...pool.keys()].sort()) {
		const items = pool.get(project)!;
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(next() * (i + 1));
			[items[i], items[j]] = [items[j]!, items[i]!];
		}
		items.forEach((item, index) => {
			if (index < cap) drawn.push(item.id);
			else notDrawn.push({ id: item.id, reason: 'over-cap' });
		});
	}
	return { seed, cap, drawn: drawn.sort(), notDrawn: notDrawn.sort(byId), projects: pool.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [path, seed, cap] = process.argv.slice(2);
	if (!path || !seed || !cap) {
		console.error('usage: draw.ts <candidates.json> <seed> <cap>');
		process.exit(2);
	}
	const text = readFileSync(path, 'utf8');
	const result = draw(JSON.parse(text) as Candidate[], seed, Number(cap));
	console.log(
		JSON.stringify({ candidatesSha256: sha256(text).toString('hex'), ...result }, null, '\t')
	);
}
