import { readFileSync } from 'node:fs';
import { runAlloc } from './ownership-alloc-modules.ts';
import { extremeMatches } from './ownership-extent-modules.ts';

// runs a mutant read from stdin on every input the ground truth uses; the parent kills it when a mutant never ends
const bytes = new Uint8Array(readFileSync(0));
for (const seed of [1, 2, 3, 4, 5, 6]) runAlloc(bytes, seed, 0);
extremeMatches(bytes, []);
