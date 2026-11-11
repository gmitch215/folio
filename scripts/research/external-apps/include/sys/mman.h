#ifndef W4B_SYS_MMAN_H
#define W4B_SYS_MMAN_H

#include <stddef.h>
#include <sys/types.h>

#define PROT_READ 1
#define MAP_PRIVATE 2
#define MAP_FAILED ((void *)-1)

void *mmap(void *, size_t, int, int, int, off_t);
int munmap(void *, size_t);

#endif
