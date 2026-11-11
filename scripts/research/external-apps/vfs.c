#include <fcntl.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define MAX_FILES 8
#define MAX_HANDLES 16
#define NAME_LEN 96
#define STDOUT_CAP (1 << 20)
#define FMT_CAP 65536
#define EXPORT(name) __attribute__((export_name(name)))

typedef struct {
	char name[NAME_LEN];
	unsigned char *data;
	size_t len;
	size_t cap;
	int used;
	int output;
} vfile;

struct shim_file {
	int file;
	size_t pos;
	int writable;
	int open;
	int eof;
	int err;
};

static vfile files[MAX_FILES];
static struct shim_file handles[MAX_HANDLES];
static struct shim_file in_handle, out_handle, err_handle;
static size_t fd_pos[MAX_FILES];
static unsigned char stdout_buf[STDOUT_CAP];
static char fmt_buf[FMT_CAP];
static char scratch[NAME_LEN];
static void *heap_base;
static size_t heap_size;
static unsigned char *out_base;
static size_t out_cap;
static int out_slots;
static int out_used;
static uint64_t rand48 = 0x1234ABCD330EULL;

FILE *stdin = &in_handle;
FILE *stdout = &out_handle;
FILE *stderr = &err_handle;

// #region host interface

EXPORT("w4b_scratch") char *w4b_scratch(void) { return scratch; }

EXPORT("w4b_init")
void w4b_init(void *heap, size_t heap_bytes, void *out, size_t cap, int slots) {
	heap_base = heap;
	heap_size = heap_bytes;
	out_base = out;
	out_cap = cap;
	out_slots = slots;
}

EXPORT("w4b_add_input")
int w4b_add_input(void *data, size_t len) {
	for (int i = 1; i < MAX_FILES; i++) {
		if (files[i].used) continue;
		memset(&files[i], 0, sizeof files[i]);
		strncpy(files[i].name, scratch, NAME_LEN - 1);
		files[i].data = data;
		files[i].len = len;
		files[i].cap = len;
		files[i].used = 1;
		return i;
	}
	return -1;
}

EXPORT("w4b_reset")
void w4b_reset(void) {
	for (int i = 1; i < MAX_FILES; i++)
		if (files[i].output) memset(&files[i], 0, sizeof files[i]);
	memset(handles, 0, sizeof handles);
	memset(fd_pos, 0, sizeof fd_pos);
	memset(&in_handle, 0, sizeof in_handle);
	memset(&out_handle, 0, sizeof out_handle);
	memset(&err_handle, 0, sizeof err_handle);
	in_handle.file = -1;
	out_handle.file = 0;
	out_handle.writable = 1;
	err_handle.file = -2;
	err_handle.writable = 1;
	strncpy(files[0].name, "<stdout>", NAME_LEN - 1);
	files[0].data = stdout_buf;
	files[0].len = 0;
	files[0].cap = STDOUT_CAP;
	files[0].used = 1;
	files[0].output = 1;
	out_used = 0;
	rand48 = 0x1234ABCD330EULL;
	bump_set(heap_base, heap_size);
}

EXPORT("w4b_lookup")
int w4b_lookup(void) {
	for (int i = 0; i < MAX_FILES; i++)
		if (files[i].used && strcmp(files[i].name, scratch) == 0) return i;
	return -1;
}

EXPORT("w4b_data") void *w4b_data(int i) { return files[i].data; }
EXPORT("w4b_len") size_t w4b_len(int i) { return files[i].len; }

// #endregion

static int find(const char *name) {
	for (int i = 1; i < MAX_FILES; i++)
		if (files[i].used && strcmp(files[i].name, name) == 0) return i;
	return -1;
}

FILE *fopen(const char *path, const char *mode) {
	int index = find(path);
	int write = mode[0] == 'w' || mode[0] == 'a';
	if (!write && index < 0) return NULL;
	if (write) {
		if (index >= 0 && !files[index].output) return NULL;
		if (index < 0) {
			if (out_used >= out_slots) return NULL;
			for (index = 1; index < MAX_FILES && files[index].used; index++) {
			}
			if (index >= MAX_FILES) return NULL;
			memset(&files[index], 0, sizeof files[index]);
			strncpy(files[index].name, path, NAME_LEN - 1);
			files[index].data = out_base + (size_t)out_used * out_cap;
			files[index].cap = out_cap;
			files[index].used = 1;
			files[index].output = 1;
			out_used++;
		}
		if (mode[0] == 'w') files[index].len = 0;
	}
	for (int h = 0; h < MAX_HANDLES; h++) {
		if (handles[h].open) continue;
		memset(&handles[h], 0, sizeof handles[h]);
		handles[h].file = index;
		handles[h].open = 1;
		handles[h].writable = write;
		handles[h].pos = mode[0] == 'a' ? files[index].len : 0;
		return &handles[h];
	}
	return NULL;
}

int fclose(FILE *f) {
	if (f >= handles && f < handles + MAX_HANDLES) f->open = 0;
	return 0;
}

int fflush(FILE *f) {
	(void)f;
	return 0;
}

size_t fread(void *buf, size_t size, size_t count, FILE *f) {
	if (f->file < 0 || !size || !count) return 0;
	vfile *v = &files[f->file];
	size_t want = size * count;
	size_t have = f->pos < v->len ? v->len - f->pos : 0;
	size_t n = want < have ? want : have;
	memcpy(buf, v->data + f->pos, n);
	f->pos += n;
	if (n < want) f->eof = 1;
	return n / size;
}

size_t fwrite(const void *buf, size_t size, size_t count, FILE *f) {
	if (f->file == -2) return count;
	if (f->file < 0 || !f->writable || !size || !count) return 0;
	vfile *v = &files[f->file];
	size_t n = size * count;
	if (f->pos + n > v->cap) {
		f->err = 1;
		return 0;
	}
	memcpy(v->data + f->pos, buf, n);
	f->pos += n;
	if (f->pos > v->len) v->len = f->pos;
	return count;
}

int fgetc(FILE *f) {
	unsigned char c;
	return fread(&c, 1, 1, f) == 1 ? c : EOF;
}

int getc(FILE *f) { return fgetc(f); }

int ungetc(int c, FILE *f) {
	if (c == EOF || f->pos == 0) return EOF;
	f->pos--;
	f->eof = 0;
	return c;
}

char *fgets(char *buf, int n, FILE *f) {
	int i = 0;
	while (i < n - 1) {
		int c = fgetc(f);
		if (c == EOF) break;
		buf[i++] = (char)c;
		if (c == '\n') break;
	}
	if (!i) return NULL;
	buf[i] = 0;
	return buf;
}

int fputc(int c, FILE *f) {
	unsigned char b = (unsigned char)c;
	return fwrite(&b, 1, 1, f) == 1 ? c : EOF;
}

int putc(int c, FILE *f) { return fputc(c, f); }
int putchar(int c) { return fputc(c, stdout); }

int fputs(const char *s, FILE *f) {
	size_t n = strlen(s);
	return n && fwrite(s, 1, n, f) != n ? EOF : 0;
}

int puts(const char *s) {
	if (fputs(s, stdout) == EOF) return EOF;
	return fputc('\n', stdout) == EOF ? EOF : 0;
}

int vfprintf(FILE *f, const char *fmt, va_list ap) {
	if (f->file == -2) return 0;
	int n = vsnprintf(fmt_buf, FMT_CAP, fmt, ap);
	if (n < 0) return n;
	size_t put = (size_t)n < FMT_CAP ? (size_t)n : FMT_CAP - 1;
	if (put && fwrite(fmt_buf, 1, put, f) != put) return -1;
	return n;
}

int vprintf(const char *fmt, va_list ap) { return vfprintf(stdout, fmt, ap); }

int fprintf(FILE *f, const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int n = vfprintf(f, fmt, ap);
	va_end(ap);
	return n;
}

int printf(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int n = vfprintf(stdout, fmt, ap);
	va_end(ap);
	return n;
}

int feof(FILE *f) { return f->eof; }
int ferror(FILE *f) { return f->err; }

int fseek(FILE *f, long offset, int whence) {
	if (f->file < 0) return -1;
	long base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? (long)f->pos : (long)files[f->file].len;
	long at = base + offset;
	if (at < 0) return -1;
	f->pos = (size_t)at;
	f->eof = 0;
	return 0;
}

long ftell(FILE *f) { return (long)f->pos; }

void rewind(FILE *f) {
	f->pos = 0;
	f->eof = 0;
	f->err = 0;
}

int open(const char *path, int flags, ...) {
	(void)flags;
	int index = find(path);
	return index < 0 ? -1 : 3 + index;
}

int close(int fd) {
	(void)fd;
	return 0;
}

ssize_t read(int fd, void *buf, size_t n) {
	int index = fd - 3;
	if (index < 1 || index >= MAX_FILES || !files[index].used) return -1;
	size_t have = fd_pos[index] < files[index].len ? files[index].len - fd_pos[index] : 0;
	if (n > have) n = have;
	memcpy(buf, files[index].data + fd_pos[index], n);
	fd_pos[index] += n;
	return (ssize_t)n;
}

void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t offset) {
	(void)addr;
	(void)len;
	(void)prot;
	(void)flags;
	int index = fd - 3;
	if (index < 1 || index >= MAX_FILES || !files[index].used) return MAP_FAILED;
	return files[index].data + offset;
}

int munmap(void *addr, size_t len) {
	(void)addr;
	(void)len;
	return 0;
}

// literals, whitespace and %[width][hh|h|l|ll]{d,u,x,X}; enough for the programs here
int sscanf(const char *s, const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int count = 0;
	while (*fmt) {
		if (*fmt == ' ') {
			while (*s == ' ' || *s == '\t' || *s == '\n') s++;
			fmt++;
		} else if (*fmt != '%') {
			if (*s != *fmt) break;
			s++;
			fmt++;
		} else {
			fmt++;
			int width = 0;
			while (*fmt >= '0' && *fmt <= '9') width = width * 10 + (*fmt++ - '0');
			int size = 0;
			while (*fmt == 'h' || *fmt == 'l') size += *fmt++ == 'h' ? -1 : 1;
			char conv = *fmt++;
			int base = conv == 'x' || conv == 'X' ? 16 : 10;
			if (conv != 'd' && conv != 'u' && base != 16) break;
			while (*s == ' ' || *s == '\t' || *s == '\n') s++;
			int negative = 0;
			if (conv == 'd' && (*s == '-' || *s == '+')) negative = *s++ == '-';
			unsigned long long value = 0;
			int digits = 0;
			while (!width || digits < width) {
				int d = *s >= '0' && *s <= '9' ? *s - '0'
					: base == 16 && *s >= 'a' && *s <= 'f' ? *s - 'a' + 10
					: base == 16 && *s >= 'A' && *s <= 'F' ? *s - 'A' + 10
					: -1;
				if (d < 0 || d >= base) break;
				value = value * base + (unsigned long long)d;
				digits++;
				s++;
			}
			if (!digits) break;
			if (negative) value = -value;
			if (size <= -2) *va_arg(ap, unsigned char *) = (unsigned char)value;
			else if (size == -1) *va_arg(ap, unsigned short *) = (unsigned short)value;
			else if (size == 1) *va_arg(ap, unsigned long *) = (unsigned long)value;
			else if (size >= 2) *va_arg(ap, unsigned long long *) = value;
			else *va_arg(ap, unsigned int *) = (unsigned int)value;
			count++;
		}
	}
	va_end(ap);
	return count;
}

double drand48(void) {
	rand48 = (rand48 * 0x5DEECE66DULL + 0xBULL) & 0xFFFFFFFFFFFFULL;
	return (double)rand48 / 281474976710656.0;
}

int clock_gettime(clockid_t id, struct timespec *ts) {
	(void)id;
	ts->tv_sec = 0;
	ts->tv_nsec = 0;
	return 0;
}

time_t time(time_t *t) {
	if (t) *t = 0;
	return 0;
}
