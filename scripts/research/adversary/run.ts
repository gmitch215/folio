import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, workDir } from './lib.ts';

// usage: node run.ts DIR certify|judge SHARD SHARDS [LIST]
// runs every module under DIR/modules whose index is SHARD mod SHARDS, or each id in the JSON array
// LIST, one child process per module with a 90 s limit. Rows go to DIR/MODE/shard-N.json, or to
// DIR/MODE-list/shard-N.json with a list.
const [dirArg, mode = 'judge', shardArg, countArg, listArg] = process.argv.slice(2);
const root = workDir(dirArg);
const shard = Number(shardArg ?? 0);
const shards = Number(countArg ?? 1);
const modules = join(root, 'modules');
const one = fileURLToPath(new URL('./one.ts', import.meta.url));

const ids = (
	listArg
		? (JSON.parse(readFileSync(listArg, 'utf8')) as string[])
		: walk(modules).map((file) => file.slice(modules.length + 1))
).filter((_, i) => i % shards === shard);
const outDir = join(root, listArg ? `${mode}-list` : mode);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `shard-${shard}.json`);
const rows: Record<string, unknown>[] = [];

for (const id of ids) {
	let row: Record<string, unknown>;
	try {
		row = JSON.parse(
			execFileSync(process.execPath, [one, mode, join(modules, id)], {
				timeout: 90_000,
				maxBuffer: 64 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe']
			}).toString()
		);
	} catch (e) {
		const err = e as { signal?: string; killed?: boolean; message?: string };
		const reason =
			err.killed || err.signal
				? `no result in 90 s (${err.signal ?? 'killed'})`
				: String(err.message).slice(0, 200);
		row =
			mode === 'certify'
				? { kind: 'harness', reason }
				: { status: 'harness', reason, wrong: false };
	}
	rows.push({ id, ...row });
	const tag = mode === 'certify' ? row.kind : `${row.status}${row.wrong ? ' WRONG' : ''}`;
	console.log(
		`${rows.length}/${ids.length} ${tag} ${id} ${row.failure ? JSON.stringify(row.failure).slice(0, 200) : (row.reason ?? '')}`.slice(
			0,
			260
		)
	);
	if (rows.length % 10 === 0) writeFileSync(out, JSON.stringify(rows, null, 1));
}
writeFileSync(out, JSON.stringify(rows, null, 1));
console.log('shard', shard, 'done', rows.length);
