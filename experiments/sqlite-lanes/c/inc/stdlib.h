#pragma once
#include <stddef.h>
void *malloc(size_t);
void *calloc(size_t, size_t);
void *realloc(void *, size_t);
void free(void *);
size_t malloc_usable_size(void *);
void abort(void);
int abs(int);
