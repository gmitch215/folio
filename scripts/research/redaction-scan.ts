import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Finding {
	file: string;
	line: number;
	rule: string;
}

// 32 or 64 hex digits count only as an id value; bare hex is also used for digests.
const rules: [string, RegExp][] = [
	['workers.dev host', /\b[a-z0-9][a-z0-9-]*\.workers\.dev\b/i],
	[
		'resource id',
		/["']?(?:id|uuid|accountId|account_id|accountTag|namespaceId|databaseId|database_id)["']?\s*[:=]\s*["']?[0-9a-f]{32}(?:[0-9a-f]{32})?\b/i
	],
	['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
	['account path', /\/accounts\/[0-9a-f]{32}\b/i],
	['bearer token', /\bbearer\s+[a-z0-9._~+/=-]{16,}/i],
	['home path', /\/(?:Users|home)\/[a-z0-9._-]+\/|\/private\/(?:var|tmp)\/|\/var\/folders\//i]
];

// reports matching lines by rule, never the matched text
export function scanText(file: string, text: string): Finding[] {
	const findings: Finding[] = [];
	text.split('\n').forEach((line, index) => {
		for (const [rule, pattern] of rules) {
			if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
		}
	});
	return findings;
}

// files with a nul byte are counted as binary and not read
export function scanPaths(paths: string[]) {
	let files = 0;
	let skippedBinary = 0;
	const findings: Finding[] = [];
	const visit = (path: string) => {
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(join(path, name));
			return;
		}
		const data = readFileSync(path);
		if (data.includes(0)) {
			skippedBinary++;
			return;
		}
		files++;
		findings.push(...scanText(path, data.toString('utf8')));
	};
	paths.forEach(visit);
	return { files, skippedBinary, findings };
}

if (import.meta.main) {
	const paths = process.argv.slice(2);
	if (paths.length === 0) throw new Error('usage: redaction-scan.ts PATH...');
	const result = scanPaths(paths);
	for (const finding of result.findings) console.log(JSON.stringify(finding));
	console.log(
		JSON.stringify({
			files: result.files,
			skippedBinary: result.skippedBinary,
			findings: result.findings.length
		})
	);
	if (result.findings.length > 0) process.exitCode = 1;
}
