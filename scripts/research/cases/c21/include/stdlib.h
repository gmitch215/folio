#pragma once
#include_next <stdlib.h>
#define EXIT_FAILURE 1
void exit(int);
void qsort(void *, size_t, size_t, int (*)(const void *, const void *));
void *bsearch(const void *, const void *, size_t, size_t, int (*)(const void *, const void *));
