// included at the end of each project file; needs GEN(i, dst) and one() defined above it.

uint32_t bulk(const rec_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) one(table + i, out + (uintptr_t)i * SLOT);
	return n;
}

uint32_t prepare(rec_t *table, uint32_t n, uint8_t *heap) {
	uint32_t used = 0;
	uintptr_t arenas = ((uintptr_t)heap + (uintptr_t)n * REC_CAP + 63) & ~(uintptr_t)63;
	gen_arena = arenas + (uintptr_t)n * ARENA;
	for (uint32_t i = 0; i < n; i++) {
		uint8_t *dst = heap + used;
		uint32_t len = GEN(i, dst);
		table[i].in = (addr_t)(uintptr_t)dst;
		table[i].len = len;
		table[i].aux = 0;
		used += (len + 15) & ~15u;
	}
	for (uint32_t i = 0; i < n; i++) table[i].arena = (addr_t)(arenas + (uintptr_t)i * ARENA);
	return used;
}
