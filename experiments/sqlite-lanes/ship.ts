import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARMS, SERIAL_PARTS, type Arm } from './plan.ts';
import type { Artifact, Manifest } from './prepare.ts';

export interface Shipment {
	set: Arm;
	slot: number;
	sha256: string;
	total: number;
	offset: number;
	partSha256: string;
	bytes: Uint8Array<ArrayBuffer>;
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function artifactsOf(manifest: Manifest, arm: Arm): Artifact[] {
	return arm === 'serial' ? [manifest.whole] : manifest.sets[arm]!;
}

// one sha256 per slot; the object checks them on every query
export const shasOf = (manifest: Manifest, arm: Arm) =>
	artifactsOf(manifest, arm).map((a) => a.sha256);

export function shipments(manifest: Manifest, dir: string): Shipment[] {
	return ARMS.flatMap((arm) =>
		artifactsOf(manifest, arm).flatMap((artifact, slot) => {
			const bytes = new Uint8Array(readFileSync(join(dir, artifact.file)));
			if (bytes.length !== artifact.bytes) throw new Error(`${artifact.file} changed size`);
			const parts = arm === 'serial' ? SERIAL_PARTS : 1;
			const size = Math.ceil(bytes.length / parts);
			return Array.from({ length: parts }, (_, p) => {
				const chunk = bytes.slice(p * size, Math.min((p + 1) * size, bytes.length));
				return {
					set: arm,
					slot,
					sha256: artifact.sha256,
					total: bytes.length,
					offset: p * size,
					partSha256: hash(chunk),
					bytes: chunk
				};
			});
		})
	);
}
