#include <stdint.h>

// the platform writes SIGXCPU here near the CPU limit; the link exports this word's address
__attribute__((used)) volatile uint32_t __instance_signal;

#define CELLS 262144u
#define TARGET 200000u

static struct {
	uint64_t lcg;
	uint32_t steps;
	uint32_t cells[CELLS];
} state = {2651435461212134099ull, 0, {0}};

static void step(void) {
	uint64_t x = state.lcg;
	for (uint32_t j = 0; j < 20000u; j++)
		x = x * 6364136223846793005ull + 1442695040888963407ull;
	for (uint32_t m = 0; m < 8; m++) {
		x = x * 6364136223846793005ull + 1442695040888963407ull;
		state.cells[(x >> 33) % CELLS] ^= (uint32_t)x;
	}
	state.lcg = x;
	state.steps++;
}

__attribute__((export_name("run"))) int32_t run(uint32_t budget) {
	for (uint32_t i = 0; i < budget && state.steps < TARGET; i++) {
		step();
		if (__instance_signal)
			break;
	}
	return state.steps >= TARGET;
}

__attribute__((export_name("get_steps"))) uint32_t get_steps(void) {
	return state.steps;
}
