import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PreparedProgram } from '../../src/compiler.ts';
import type { Folio } from '../../src/node.ts';

const archive = new URL('../../results/execution/admission/old-build-src.tar.gz', import.meta.url);
const target = new URL('../../build/old-build/', import.meta.url);

export interface OldBuild {
	/** sha256 of the archived source tree */
	digest: string;
	prepare(bytes: Uint8Array): PreparedProgram;
	Folio: typeof Folio;
}

/** Unpacks the src/ tree from before static admission and imports it beside the current one. */
export async function openOldBuild(): Promise<OldBuild> {
	const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
	const stamp = new URL('digest', target);
	if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== digest) {
		mkdirSync(target, { recursive: true });
		execFileSync('tar', ['-xzf', archive.pathname, '-C', target.pathname]);
		writeFileSync(stamp, digest);
	}
	const [compiler, node] = await Promise.all([
		import(new URL('src/compiler.ts', target).href),
		import(new URL('src/node.ts', target).href)
	]);
	return { digest, prepare: compiler.prepare, Folio: node.Folio };
}
