import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Fence {
	file: string;
	line: number;
	language: 'ts' | 'typescript';
	flags: string[];
	code: string;
}

export interface PlannedFence {
	fence: Fence;
	out: string;
}

const OPEN = /^(?<prefix>[ \t>]*)(?<ticks>`{3,})[ \t]*(?<language>[^\s`]*)[ \t]*(?<info>.*)$/;
const NAMED = /^\/\/ (?<path>[\w@.[\]-]+(?:\/[\w@.[\]-]+)*\.(?:ts|mts))(?: and .*)?$/;

// the ts and typescript fences of a page, including those inside lists and quotes
export function extractFences(markdown: string, file: string): Fence[] {
	const lines = markdown.split(/\r?\n/);
	const fences: Fence[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = OPEN.exec(lines[i] ?? '');
		if (!open?.groups) continue;
		const { prefix = '', ticks = '', language = '', info = '' } = open.groups;
		const quotes = prefix.split('>').length - 1;
		const indent = (prefix.split('>').pop() ?? '').length;
		const strip = (text: string) => {
			let rest = text;
			for (let q = 0; q < quotes; q++) rest = rest.replace(/^[ \t]*>[ \t]?/, '');
			return rest.replace(new RegExp(`^[ \\t]{0,${indent}}`), '');
		};
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const text = strip(lines[j] ?? '');
			if (new RegExp(`^[ \\t]*\`{${ticks.length},}[ \\t]*$`).test(text)) break;
			body.push(text);
		}
		if (language === 'ts' || language === 'typescript') {
			fences.push({
				file,
				line: i + 1,
				language,
				flags: info.split(/\s+/).filter(Boolean),
				code: `${body.join('\n')}\n`
			});
		}
		i = j;
	}
	return fences;
}

// the pages that exist among the readme, the guides, the module and study pages and the report
export function fenceDocs(root: string): string[] {
	const pages = existsSync(join(root, 'docs'))
		? (readdirSync(join(root, 'docs'), { recursive: true }) as string[])
				.map((p) => `docs/${p.replaceAll('\\', '/')}`)
				.filter((p) => p.endsWith('.md'))
				.sort()
		: [];
	return ['README.md', 'ADVANCED_USAGE.md', ...pages, 'TECHNICAL_REPORT.md'].filter((doc) =>
		existsSync(join(root, doc))
	);
}

// docs/modules/core.md becomes modules-core, README.md becomes readme
export function docSlug(file: string): string {
	return file
		.replace(/^docs\//, '')
		.replace(/\.md$/, '')
		.replaceAll('/', '-')
		.replaceAll('.', '-')
		.replaceAll('_', '-')
		.toLowerCase();
}

// a fence that opens with `// path/to/file.ts` is written at that path inside its page folder so
// sibling fences can import it; every other fence is <n>.ts, n counting the page's ts fences
export function planFences(file: string, fences: Fence[]): PlannedFence[] {
	const slug = docSlug(file);
	const taken = new Set<string>();
	const planned: PlannedFence[] = [];
	fences.forEach((fence, index) => {
		if (fence.flags.includes('no-check')) return;
		const named = NAMED.exec(fence.code.split('\n')[0] ?? '')?.groups?.['path'];
		const usable = named && !named.split('/').some((part) => part === '.' || part === '..');
		const name = usable && !taken.has(named) ? named : `${index + 1}.ts`;
		taken.add(name);
		planned.push({ fence, out: `${slug}/${name}` });
	});
	return planned;
}

// empties outDir and writes every planned fence under it; a path that leaves the folder throws
export function writeFences(outDir: string, planned: PlannedFence[]): void {
	const base = resolve(outDir);
	const targets = planned.map(({ fence, out }) => {
		const target = resolve(base, out);
		if (!target.startsWith(base + sep)) {
			throw new Error(`${fence.file}:${fence.line} would write outside ${outDir}: ${out}`);
		}
		return { target, code: fence.code };
	});
	rmSync(base, { recursive: true, force: true });
	for (const { target, code } of targets) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, code);
	}
}

export interface FenceReport {
	checked: Map<string, number>;
	skipped: string[];
	problems: string[];
}

export interface FenceOptions {
	outDir?: string;
	tsconfig?: string;
	docs?: string[];
}

// a compile error in doc coordinates: README.md:134:7 error TS2322: ...
export function formatProblem(
	planned: PlannedFence | undefined,
	where: { line: number; column: number } | undefined,
	code: number,
	message: string,
	fallbackFile = ''
): string {
	if (!planned || !where)
		return `${fallbackFile}${fallbackFile ? ' ' : ''}error TS${code}: ${message}`;
	const { fence } = planned;
	return `${fence.file}:${fence.line + where.line}:${where.column} error TS${code}: ${message}`;
}

export function checkFences(root: string, config: FenceOptions = {}): FenceReport {
	const outDir = resolve(root, config.outDir ?? 'build/docs-fences');
	const tsconfig = resolve(root, config.tsconfig ?? 'scripts/docs/tsconfig.fences.json');
	const checked = new Map<string, number>();
	const skipped: string[] = [];
	const planned: PlannedFence[] = [];
	for (const doc of config.docs ?? fenceDocs(root)) {
		const fences = extractFences(readFileSync(join(root, doc), 'utf8'), doc);
		for (const fence of fences) {
			if (fence.flags.includes('no-check')) skipped.push(`${doc}:${fence.line}`);
		}
		const plan = planFences(doc, fences);
		if (plan.length > 0) checked.set(doc, plan.length);
		planned.push(...plan);
	}
	writeFences(outDir, planned);

	const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
	const ambient = parsed.fileNames.filter((name) => name.endsWith('.d.ts'));
	const rootNames = [...planned.map(({ out }) => resolve(outDir, out)), ...ambient];
	const program = ts.createProgram({ rootNames, options: parsed.options });
	const byFile = new Map(planned.map((p) => [resolve(outDir, p.out), p]));
	const problems = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
		const file = diagnostic.file;
		if (!file || diagnostic.start === undefined)
			return formatProblem(undefined, undefined, diagnostic.code, message);
		const at = file.getLineAndCharacterOfPosition(diagnostic.start);
		const where = { line: at.line + 1, column: at.character + 1 };
		const plan = byFile.get(resolve(file.fileName));
		if (plan) return formatProblem(plan, where, diagnostic.code, message);
		return formatProblem(
			undefined,
			undefined,
			diagnostic.code,
			message,
			`${file.fileName.slice(root.length + 1)}:${where.line}:${where.column}`
		);
	});
	return { checked, skipped, problems };
}

if (import.meta.main) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const report = checkFences(root);
	const total = [...report.checked.values()].reduce((sum, n) => sum + n, 0);
	console.log(
		`fences: ${total} compiled in ${report.checked.size} pages, ${report.skipped.length} no-check`
	);
	for (const problem of report.problems) console.error(problem);
	if (report.problems.length > 0) process.exitCode = 1;
}
