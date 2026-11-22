import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GROUP, PAGE } from './host.mjs';

export class RestoreRefused extends Error {}

const GROUP_PAGES = GROUP / PAGE;

function hashBlob(h) {
	return Buffer.from(new BigUint64Array([h]).buffer);
}

// mode 'page' writes one row per changed 64 KiB page; 'group' writes one row per changed 1 MiB group.
export class Store {
	constructor(file, mode) {
		this.mode = mode;
		this.db = new DatabaseSync(file);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS page (epoch INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB, bytes BLOB NOT NULL, PRIMARY KEY (epoch, idx));
			CREATE INDEX IF NOT EXISTS page_idx ON page (idx, epoch);
			CREATE TABLE IF NOT EXISTS manifest (epoch INTEGER PRIMARY KEY, mode TEXT NOT NULL, pages INTEGER NOT NULL, root BLOB NOT NULL, globals TEXT NOT NULL, steps INTEGER NOT NULL, hashes BLOB NOT NULL);
		`);
		this.insPage = this.db.prepare(
			'INSERT INTO page (epoch, idx, hash, bytes) VALUES (?, ?, ?, ?)'
		);
		this.insManifest = this.db.prepare('INSERT INTO manifest VALUES (?, ?, ?, ?, ?, ?, ?)');
		this.epoch = 0;
		this.last = null;
	}

	checkpoint(memory, hash, steps, globals) {
		const t0 = performance.now();
		hash.hashPages(0, hash.pages);
		const hashes = hash.hashes.slice(0, hash.pages);
		const changed = [];
		for (let p = 0; p < hash.pages; p++) {
			if (!this.last || this.last[p] !== hashes[p]) changed.push(p);
		}
		const units =
			this.mode === 'group'
				? [...new Set(changed.map((p) => Math.floor(p / GROUP_PAGES)))]
				: changed;
		const span = this.mode === 'group' ? GROUP : PAGE;
		const view = new Uint8Array(memory.buffer);
		const epoch = this.epoch + 1;
		let bytes = 0;
		this.db.exec('BEGIN');
		try {
			for (const u of units) {
				const data = view.subarray(u * span, (u + 1) * span);
				this.insPage.run(
					epoch,
					u,
					this.mode === 'group' ? null : hashBlob(hashes[u]),
					data
				);
				bytes += data.byteLength;
			}
			const root = createHash('sha256').update(new Uint8Array(hashes.buffer)).digest();
			this.insManifest.run(
				epoch,
				this.mode,
				hash.pages,
				root,
				globals,
				steps,
				Buffer.from(hashes.buffer)
			);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
		this.last = hashes;
		this.epoch = epoch;
		return {
			epoch,
			pagesChanged: changed.length,
			rows: units.length,
			bytes,
			ms: performance.now() - t0
		};
	}

	// Loads the newest row of every unit at or before the last manifest, then checks every page.
	restore(memory, hash) {
		const m = this.db.prepare('SELECT * FROM manifest ORDER BY epoch DESC LIMIT 1').get();
		if (!m) throw new RestoreRefused('no committed manifest');
		const t0 = performance.now();
		const span = m.mode === 'group' ? GROUP : PAGE;
		const rows = this.db
			.prepare(
				`
			SELECT p.idx AS idx, p.bytes AS bytes FROM page p
			WHERE p.epoch = (SELECT MAX(q.epoch) FROM page q WHERE q.idx = p.idx AND q.epoch <= ?)
		`
			)
			.all(m.epoch);
		const view = new Uint8Array(memory.buffer);
		for (const r of rows) view.set(r.bytes, r.idx * span);
		hash.hashPages(0, hash.pages);
		const got = hash.hashes.slice(0, m.pages);
		const want = new BigUint64Array(new Uint8Array(m.hashes).buffer);
		const root = createHash('sha256').update(new Uint8Array(want.buffer)).digest();
		if (!root.equals(Buffer.from(m.root)))
			throw new RestoreRefused('manifest root does not match its page hashes');
		const bad = [];
		for (let p = 0; p < m.pages; p++) {
			if (got[p] !== want[p]) bad.push(p);
		}
		if (bad.length) {
			throw new RestoreRefused(
				`${bad.length} page(s) fail the hash check, first ${bad.slice(0, 5).join(', ')}`
			);
		}
		this.last = want;
		this.epoch = m.epoch;
		return {
			memory,
			steps: m.steps,
			epoch: m.epoch,
			rowsLoaded: rows.length,
			pagesVerified: m.pages,
			ms: performance.now() - t0
		};
	}

	// Test hook: flips one byte of the newest stored row.
	corruptNewest() {
		const r = this.db
			.prepare('SELECT epoch, idx, bytes FROM page ORDER BY epoch DESC, idx ASC LIMIT 1')
			.get();
		const b = Buffer.from(r.bytes);
		b[4096] ^= 0x01;
		this.db
			.prepare('UPDATE page SET bytes = ? WHERE epoch = ? AND idx = ?')
			.run(b, r.epoch, r.idx);
		return { epoch: r.epoch, idx: r.idx, offset: 4096 };
	}

	close() {
		this.db.close();
	}
}
