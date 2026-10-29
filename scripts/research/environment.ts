import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import { join } from 'node:path';

export const digest = (bytes: Uint8Array | string) =>
	createHash('sha256').update(bytes).digest('hex');

/** Records runtime and exact source inputs without machine names, credentials or local paths. */
export function researchEnvironment(configuration: Record<string, unknown>) {
	const root = new URL('../../', import.meta.url).pathname;
	const sources: Record<string, string> = {};
	for (const directory of ['src', 'scripts/research']) {
		const visit = (relative: string) => {
			for (const name of readdirSync(join(root, relative)).sort()) {
				const path = `${relative}/${name}`;
				if (statSync(join(root, path)).isDirectory()) visit(path);
				else if (/\.(?:ts|c|h|json)$/.test(name))
					sources[path] = digest(readFileSync(join(root, path)));
			}
		};
		visit(directory);
	}
	const affinity =
		platform() === 'linux'
			? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
			: undefined;
	const governor = '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor';
	return {
		kind: 'environment',
		schema: 'folio.research.v1',
		observedAt: new Date().toISOString(),
		revision:
			process.env.FOLIO_RESEARCH_REVISION ??
			execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
		node: process.version,
		v8: process.versions.v8,
		os: platform(),
		release: release(),
		cpu: cpus()[0]?.model,
		hardwareThreads: cpus().length,
		affinity,
		governor: existsSync(governor) ? readFileSync(governor, 'utf8').trim() : undefined,
		load: loadavg(),
		configuration,
		sources,
		sourceDigest: digest(JSON.stringify(sources))
	};
}
