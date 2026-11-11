import { readFileSync } from 'node:fs';
import { runAlloc } from './ownership-alloc-modules.ts';
import { runRecords } from './ownership-modules.ts';

// one serial run of a hand module read from stdin; the adversaries cut this process off when a mutant never returns
const bytes = new Uint8Array(readFileSync(0));
if (process.argv[2] === 'alloc') runAlloc(bytes, 1, 0);
else runRecords(bytes, 1, undefined);
