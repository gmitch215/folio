#include "sqlite3.h"
#include <string.h>

/* No files exist in this build. The default VFS refuses every open; :memory: and deserialize never reach it. */

static int stub_close(sqlite3_file *f) { (void)f; return SQLITE_OK; }
static int stub_read(sqlite3_file *f, void *b, int n, sqlite3_int64 o) {
	(void)f; (void)b; (void)n; (void)o; return SQLITE_IOERR_READ;
}
static int stub_write(sqlite3_file *f, const void *b, int n, sqlite3_int64 o) {
	(void)f; (void)b; (void)n; (void)o; return SQLITE_IOERR_WRITE;
}
static int stub_trunc(sqlite3_file *f, sqlite3_int64 s) { (void)f; (void)s; return SQLITE_IOERR; }
static int stub_sync(sqlite3_file *f, int fl) { (void)f; (void)fl; return SQLITE_OK; }
static int stub_size(sqlite3_file *f, sqlite3_int64 *s) { (void)f; *s = 0; return SQLITE_OK; }
static const sqlite3_io_methods stub_io = {
	1, stub_close, stub_read, stub_write, stub_trunc, stub_sync, stub_size,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
};

static int stub_open(sqlite3_vfs *v, const char *name, sqlite3_file *f, int flags, int *out) {
	(void)v; (void)name; (void)f; (void)flags; (void)out;
	return SQLITE_CANTOPEN;
}
static int stub_delete(sqlite3_vfs *v, const char *n, int s) { (void)v; (void)n; (void)s; return SQLITE_IOERR_DELETE; }
static int stub_access(sqlite3_vfs *v, const char *n, int f, int *r) { (void)v; (void)n; (void)f; *r = 0; return SQLITE_OK; }
static int stub_full(sqlite3_vfs *v, const char *n, int nout, char *out) {
	(void)v; (void)n; if (nout > 0) { size_t i = strlen(n); if ((int)i >= nout) i = nout - 1; memcpy(out, n, i); out[i] = 0; }
	return SQLITE_OK;
}
static void *stub_dl_open(sqlite3_vfs *v, const char *n) { (void)v; (void)n; return 0; }
static void stub_dl_error(sqlite3_vfs *v, int n, char *m) { (void)v; (void)n; if (m) m[0] = 0; }
static void (*stub_dl_sym(sqlite3_vfs *v, void *h, const char *s))(void) { (void)v; (void)h; (void)s; return 0; }
static void stub_dl_close(sqlite3_vfs *v, void *h) { (void)v; (void)h; }
static int stub_rand(sqlite3_vfs *v, int n, char *out) { (void)v; memset(out, 0, n); return n; }
static int stub_sleep(sqlite3_vfs *v, int us) { (void)v; return us; }
static int stub_time(sqlite3_vfs *v, double *t) { (void)v; *t = 2440587.5; return SQLITE_OK; }
static int stub_last(sqlite3_vfs *v, int n, char *m) { (void)v; (void)n; if (m) m[0] = 0; return 0; }
static int stub_time64(sqlite3_vfs *v, sqlite3_int64 *t) { (void)v; *t = 210866760000000LL; return SQLITE_OK; }

static sqlite3_vfs stub_vfs = {
	1, sizeof(sqlite3_file), 1024, 0, "stub", 0,
	stub_open, stub_delete, stub_access, stub_full,
	stub_dl_open, stub_dl_error, stub_dl_sym, stub_dl_close,
	stub_rand, stub_sleep, stub_time, stub_last, stub_time64,
	0, 0, 0
};

int sqlite3_os_init(void) {
	return sqlite3_vfs_register(&stub_vfs, 1);
}

int sqlite3_os_end(void) {
	return SQLITE_OK;
}
