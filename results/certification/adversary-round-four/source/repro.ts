import { evaluate } from './lib.ts';

// usage: repro.ts MODULE.wasm ENTRY [BASE.wasm]   (VFULL=1 for the verifier's full options)
// prints the whole row: checker verdict, verifier verdict, ground truth, borrowed-certificate verdict
const [file, entry, base] = process.argv.slice(2);
const row = evaluate({ id: file!, family: 'repro', file: file!, entry, base }, true);
console.log(JSON.stringify(row, null, 1));
