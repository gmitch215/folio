import { readFileSync } from 'node:fs';
import { certifyStream, type StreamCertificate } from '../../../../src/certify.ts';
import { verifyCertificate } from '../../../../scripts/research/certify-verify.ts';
import { sha, VOPT } from './lib.ts';

// usage: borrow-one.ts MODULE BASE ENTRY: the verifier on BASE's certificate re-pointed at MODULE
const [file, base, entry] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(file!));
const bc = certifyStream(new Uint8Array(readFileSync(base!)), entry!) as StreamCertificate;
const patched = { ...bc, moduleSha256: sha(bytes) } as StreamCertificate;
const t = performance.now();
const v = verifyCertificate(bytes, patched, VOPT);
console.log(JSON.stringify(v), Math.round(performance.now() - t), 'ms');
