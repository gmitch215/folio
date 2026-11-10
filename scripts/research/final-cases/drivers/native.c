#include <stdio.h>
#include <stdlib.h>

#include "harness.h"

// native baseline: system malloc, the arena slices are laid out and left unused.
void bump_set(void *base, size_t size) {
	(void)base;
	(void)size;
}

uint32_t bulk(const rec_t *table, uint32_t n, uint8_t *out);
uint32_t prepare(rec_t *table, uint32_t n, uint8_t *heap);

int main(int argc, char **argv) {
	if (argc != 2) return 2;
	rec_t *table = calloc(RECORDS, sizeof *table);
	uint8_t *heap = calloc((size_t)RECORDS * (REC_CAP + ARENA) + GEN_ARENA + 64, 1);
	uint8_t *out = calloc((size_t)RECORDS * SLOT, 1);
	if (!table || !heap || !out) return 1;
	prepare(table, RECORDS, heap);
	bulk(table, RECORDS, out);
	FILE *f = fopen(argv[1], "wb");
	if (!f) return 1;
	size_t total = (size_t)RECORDS * SLOT;
	if (fwrite(out, 1, total, f) != total) return 1;
	return fclose(f) ? 1 : 0;
}
