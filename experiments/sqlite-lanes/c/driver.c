#include "sqlite3.h"
#include <string.h>

/* one connection per instance; the host passes SQL and reads text rows through the io buffer */

#define IO_BYTES (1 << 20)

static sqlite3 *db;
static unsigned char io[IO_BYTES];
static char errbuf[512];
static int errlen;
static sqlite3_int64 last_count;
static sqlite3_int64 last_sum;
static sqlite3_int64 last_vm_steps;

__attribute__((export_name("io_ptr"))) unsigned char *io_ptr(void) { return io; }
__attribute__((export_name("io_bytes"))) int io_bytes(void) { return IO_BYTES; }
__attribute__((export_name("err_ptr"))) char *err_ptr(void) { return errbuf; }
__attribute__((export_name("vm_steps"))) sqlite3_int64 vm_steps(void) { return last_vm_steps; }
__attribute__((export_name("err_len"))) int err_len(void) { return errlen; }
__attribute__((export_name("lib_version"))) int lib_version(void) { return sqlite3_libversion_number(); }

static int fail(int rc) {
	const char *m = sqlite3_errmsg(db);
	errlen = (int)strlen(m);
	if (errlen > (int)sizeof errbuf - 1) errlen = sizeof errbuf - 1;
	memcpy(errbuf, m, errlen);
	return rc;
}

__attribute__((export_name("open_empty"))) int open_empty(void) {
	if (db) sqlite3_close(db);
	return sqlite3_open_v2(":memory:", &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, 0);
}

/* io[0..n) holds one or more statements; no rows are returned */
__attribute__((export_name("exec"))) int exec(int n) {
	io[n] = 0;
	char *sql = (char *)io;
	int rc = sqlite3_exec(db, sql, 0, 0, 0);
	return rc ? fail(rc) : 0;
}

/* image bytes come from the host; the connection reads them in place, read-only */
__attribute__((export_name("image_alloc"))) unsigned char *image_alloc(int n) {
	return sqlite3_malloc64((sqlite3_uint64)n);
}

__attribute__((export_name("open_image"))) int open_image(unsigned char *p, int n) {
	if (db) sqlite3_close(db);
	db = 0;
	int rc = sqlite3_open_v2(":memory:", &db, SQLITE_OPEN_READWRITE, 0);
	if (rc) return rc;
	rc = sqlite3_deserialize(db, "main", p, n, n, SQLITE_DESERIALIZE_READONLY);
	return rc ? fail(rc) : 0;
}

static sqlite3_int64 serial_len;

__attribute__((export_name("serialize"))) unsigned char *serialize(void) {
	return sqlite3_serialize(db, "main", &serial_len, 0);
}

__attribute__((export_name("serial_len"))) sqlite3_int64 serial_length(void) { return serial_len; }

/* io[0..n) is one statement that returns rows; the output replaces io as "a|b\n" text. returns the byte count or -1 on error */
__attribute__((export_name("query_text"))) int query_text(int n) {
	io[n] = 0;
	sqlite3_stmt *st = 0;
	int rc = sqlite3_prepare_v2(db, (char *)io, n, &st, 0);
	if (rc) {
		fail(rc);
		return -1;
	}
	int cols = sqlite3_column_count(st);
	int out = 0;
	while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
		for (int c = 0; c < cols; c++) {
			if (c) io[out++] = '|';
			const unsigned char *t = sqlite3_column_text(st, c);
			int len = sqlite3_column_bytes(st, c);
			if (out + len + 2 > IO_BYTES) {
				sqlite3_finalize(st);
				errlen = 0;
				return -2;
			}
			if (t) memcpy(io + out, t, len);
			out += len;
		}
		io[out++] = '\n';
	}
	last_vm_steps = sqlite3_stmt_status(st, SQLITE_STMTSTATUS_VM_STEP, 0);
	sqlite3_finalize(st);
	if (rc != SQLITE_DONE) {
		fail(rc);
		return -1;
	}
	return out;
}

/* one range query per call: count and sum of v over k in [a, b], written as two i64 at out */
__attribute__((export_name("range_stats"))) int range_stats(long long a, long long b, long long *out) {
	sqlite3_stmt *st = 0;
	int rc = sqlite3_prepare_v3(db, "SELECT count(*), sum(v) FROM t WHERE k BETWEEN ?1 AND ?2", -1, 0,
		&st, 0);
	if (rc) return fail(rc);
	sqlite3_bind_int64(st, 1, a);
	sqlite3_bind_int64(st, 2, b);
	rc = sqlite3_step(st);
	if (rc != SQLITE_ROW) {
		sqlite3_finalize(st);
		return fail(rc);
	}
	out[0] = sqlite3_column_int64(st, 0);
	out[1] = sqlite3_column_type(st, 1) == SQLITE_NULL ? 0 : sqlite3_column_int64(st, 1);
	sqlite3_finalize(st);
	return 0;
}

/* the automatic route: records[i] = (a, b) at table, results at out[16 * i]; a failed record writes count -1 */
__attribute__((export_name("records"))) void records(long long *table, int n, long long *out) {
	for (int i = 0; i < n; i++) {
		if (range_stats(table[2 * i], table[2 * i + 1], out + 2 * i)) {
			out[2 * i] = -1;
			out[2 * i + 1] = 0;
		}
	}
}
