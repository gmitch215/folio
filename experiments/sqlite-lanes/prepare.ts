import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_ROWS, LOOKUP_ROWS, ranges, wholeRange, type Range } from './queries.ts';
import { Sqlite, sharedMemory } from './sqlite.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const MODULE_PATH = join(here, 'build', 'sqlite-lanes.wasm');
export const FIXTURE_DIR = join(here, 'build', 'fixture');
const CLANG = '/opt/homebrew/opt/llvm/bin/clang';
const MAX_SHARD_BYTES = 14 * 1024 * 1024;
const WIDTHS = [4, 8];
const SCHEMA =
	'CREATE TABLE t(id INTEGER PRIMARY KEY, k INTEGER, v INTEGER, s TEXT); CREATE TABLE u(id INTEGER PRIMARY KEY, w INTEGER);';

export interface Artifact {
	file: string;
	bytes: number;
	sha256: string;
	idLo: number;
	idHi: number;
}

export interface Manifest {
	rows: number;
	sqlite: number;
	whole: Artifact;
	sets: Record<string, Artifact[]>;
}

// flags from the single-instance build script, except --initial-memory: 16 MiB here so the module
// instantiates in a 128 MB isolate. the heap grows on demand.
export function buildModule(source = process.env.FOLIO_SQLITE_SOURCE) {
	const inputs = ['os.c', 'libc.c', 'driver.c'].map((f) => join(here, 'c', f));
	const fresh =
		existsSync(MODULE_PATH) &&
		inputs.every((f) => mtime(f) <= mtime(MODULE_PATH)) &&
		(!source || mtime(join(source, 'sqlite3.c')) <= mtime(MODULE_PATH));
	if (fresh) return;
	if (!source)
		throw new Error('set FOLIO_SQLITE_SOURCE to the directory holding sqlite3.c and sqlite3.h');
	inputs.push(join(source, 'sqlite3.c'));
	mkdirSync(dirname(MODULE_PATH), { recursive: true });
	const path = (process.env.PATH ?? '')
		.split(':')
		.filter((p) => !p.includes('node_modules/.bin'))
		.join(':');
	execFileSync(
		CLANG,
		[
			'--target=wasm32',
			'-O2',
			'-g0',
			'-ffreestanding',
			'-fno-builtin',
			'-nostdlib',
			'-matomics',
			'-mbulk-memory',
			'-mllvm',
			'-disable-loop-idiom-all',
			'-DSQLITE_OS_OTHER=1',
			'-DSQLITE_THREADSAFE=0',
			'-DSQLITE_TEMP_STORE=3',
			'-DSQLITE_OMIT_LOAD_EXTENSION',
			'-DSQLITE_OMIT_WAL',
			'-DSQLITE_OMIT_LOCALTIME',
			'-DSQLITE_OMIT_DATETIME_FUNCS',
			'-DSQLITE_MAX_MMAP_SIZE=0',
			'-DSQLITE_DEFAULT_MEMSTATUS=0',
			'-DSQLITE_OMIT_SHARED_CACHE',
			'-DLONGDOUBLE_TYPE=double',
			'-DSQLITE_DEFAULT_CACHE_SIZE=-2000',
			'-I',
			join(here, 'c', 'inc'),
			'-I',
			source,
			...inputs,
			'-w',
			'-o',
			MODULE_PATH,
			'-Wl,--no-entry,--import-memory,--shared-memory,--initial-memory=16777216,--max-memory=2147483648',
			'-Wl,-z,stack-size=1048576'
		],
		{ env: { ...process.env, PATH: path }, stdio: 'pipe' }
	);
}

function mtime(path: string) {
	return statSync(path).mtimeMs;
}

export function moduleFromDisk() {
	return new WebAssembly.Module(readFileSync(MODULE_PATH));
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// one instance per image; the builder never holds two images at once
const fresh = () => new Sqlite(moduleFromDisk(), sharedMemory(32768));

// the rows of one range; the same expressions serve every shard and the whole table
function imageOf(range: Range) {
	const db = fresh();
	db.openEmpty();
	db.exec(SCHEMA);
	db.exec(
		`WITH RECURSIVE c(x) AS (SELECT ${range.lo} UNION ALL SELECT x+1 FROM c WHERE x<${range.hi})
		 INSERT INTO t SELECT x, (x*7919)%100003, (x*104729)%1000003,
		   printf('%023d', x) || char(97 + x % 26) FROM c;`
	);
	db.exec(
		`WITH RECURSIVE c(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM c WHERE x<${LOOKUP_ROWS - 1})
		 INSERT INTO u SELECT x, (x*31+7)%1000 FROM c;`
	);
	db.exec('CREATE INDEX ik ON t(k);');
	return db.serialize();
}

function sum(image: Uint8Array) {
	const db = fresh();
	db.beginImage(image.length);
	db.writeImage(0, image);
	db.openImage();
	return db.query('SELECT count(*), sum(v) FROM t').text.trim();
}

function artifact(dir: string, file: string, image: Uint8Array, range: Range): Artifact {
	if (image.length > MAX_SHARD_BYTES && file !== 'whole.db')
		throw new Error(
			`${file} is ${image.length} bytes, over the ${MAX_SHARD_BYTES} shard limit`
		);
	writeFileSync(join(dir, file), image);
	return { file, bytes: image.length, sha256: hash(image), idLo: range.lo, idHi: range.hi };
}

// builds the whole table, then each width's shards; checks shard counts and sums against the whole
export function buildFixture(dir = FIXTURE_DIR, rows = FIXTURE_ROWS): Manifest {
	mkdirSync(dir, { recursive: true });
	const whole = wholeRange(rows);
	const image = imageOf(whole);
	const expected = sum(image);
	const wholeArtifact = artifact(dir, 'whole.db', image, whole);
	const sets: Record<string, Artifact[]> = {};
	for (const width of WIDTHS) {
		const parts = ranges(width, rows).map((range, slot) => {
			const shard = imageOf(range);
			const file = `shards-${width}-${slot}.db`;
			return artifact(dir, file, shard, range);
		});
		sets[`shards-${width}`] = parts;
		let count = 0n;
		let total = 0n;
		for (const [slot, range] of ranges(width, rows).entries()) {
			const bytes = readFileSync(join(dir, parts[slot]!.file));
			const [c, s] = sum(bytes).split('|');
			count += BigInt(c!);
			total += BigInt(s!);
			const expectedRows = range.hi - range.lo + 1;
			if (BigInt(c!) !== BigInt(expectedRows))
				throw new Error(
					`shard ${slot} of ${width} holds ${c} rows, expected ${expectedRows}`
				);
		}
		const [wc, ws] = expected.split('|');
		if (count !== BigInt(wc!) || total !== BigInt(ws!))
			throw new Error(`${width} shards do not sum to the whole table`);
	}
	const manifest: Manifest = { rows, sqlite: 3050004, whole: wholeArtifact, sets };
	writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

export function readManifest(dir = FIXTURE_DIR): Manifest {
	return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

if (import.meta.main) {
	buildModule();
	const manifest = buildFixture();
	console.log(
		JSON.stringify({
			module: MODULE_PATH,
			rows: manifest.rows,
			whole: { bytes: manifest.whole.bytes, sha256: manifest.whole.sha256 },
			sets: Object.fromEntries(
				Object.entries(manifest.sets).map(([k, v]) => [k, v.map((a) => a.bytes)])
			)
		})
	);
}
