import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type ExportValue = { types: string; import: string } | string;

export interface ExportEntry {
	key: string;
	js: string;
	types: string;
}

export interface KeySurface {
	runtime: string[];
	declarations: Record<string, string>;
}

export interface Surface {
	keys: Record<string, KeySurface>;
}

export interface Check {
	kind: 'url' | 'import';
	file: string;
	literal: string;
	target: string;
	ok: boolean;
}

const workerUrl = /new URL\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*,\s*import\.meta\.url\s*\)/g;
const dynamicImport = /import\(\s*(['"`])(\.{1,2}\/[^'"`]*)\1\s*\)/g;
const templateHole = /\$\{[^}]*\}/g;

export function exportEntries(exportsMap: Record<string, ExportValue>): ExportEntry[] {
	return Object.keys(exportsMap)
		.filter((key) => key !== './package.json')
		.sort()
		.map((key) => {
			const value = exportsMap[key];
			if (value === undefined || typeof value === 'string') {
				throw new Error(`export ${key} needs both a types and an import entry`);
			}
			return { key, js: value.import, types: value.types };
		});
}

export function sourcePath(distDir: string, fileName: string): string {
	const rel = relative(distDir, fileName).split(sep).join('/');
	if (rel.startsWith('..')) return rel;
	return `src/${rel.replace(/\.d\.ts$/, '.ts')}`;
}

export function declarationNames(
	program: ts.Program,
	distDir: string,
	typesFile: string
): Record<string, string> {
	const sourceFile = program.getSourceFile(typesFile);
	if (!sourceFile) throw new Error(`declaration file not in program: ${typesFile}`);
	const checker = program.getTypeChecker();
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
	if (!moduleSymbol) throw new Error(`no module symbol for ${typesFile}`);
	const names: Record<string, string> = {};
	for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
		const target =
			symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		const declaration = target.declarations?.[0];
		names[symbol.name] = declaration
			? sourcePath(distDir, declaration.getSourceFile().fileName)
			: '<unresolved>';
	}
	return names;
}

export async function recordSurface(
	root: string,
	exportsMap: Record<string, ExportValue>
): Promise<Surface> {
	const distDir = join(root, 'dist');
	const entries = exportEntries(exportsMap);
	const program = ts.createProgram(
		entries.map((entry) => join(root, entry.types)),
		{
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
			noLib: true,
			types: [],
			skipLibCheck: true,
			noEmit: true
		}
	);
	const keys: Record<string, KeySurface> = {};
	for (const entry of entries) {
		const module = await import(pathToFileURL(join(root, entry.js)).href);
		keys[entry.key] = {
			runtime: Object.keys(module).sort(),
			declarations: declarationNames(program, distDir, join(root, entry.types))
		};
	}
	return { keys };
}

function setDiff(key: string, kind: string, before: string[], after: string[]): string[] {
	const was = new Set(before);
	const now = new Set(after);
	const added = after.filter((name) => !was.has(name));
	const removed = before.filter((name) => !now.has(name));
	const lines: string[] = [];
	if (added.length > 0) lines.push(`${key} ${kind} added: ${added.join(', ')}`);
	if (removed.length > 0) lines.push(`${key} ${kind} removed: ${removed.join(', ')}`);
	return lines;
}

export function diffSurfaces(base: Surface, current: Surface): string[] {
	const keys = [...new Set([...Object.keys(base.keys), ...Object.keys(current.keys)])].sort();
	const lines: string[] = [];
	for (const key of keys) {
		const was = base.keys[key];
		const now = current.keys[key];
		if (!was) {
			lines.push(`${key} key added`);
			continue;
		}
		if (!now) {
			lines.push(`${key} key removed`);
			continue;
		}
		lines.push(...setDiff(key, 'runtime', was.runtime, now.runtime));
		lines.push(
			...setDiff(
				key,
				'declarations',
				Object.keys(was.declarations),
				Object.keys(now.declarations)
			)
		);
	}
	return lines;
}

export interface UnionReport {
	runtime: number;
	declarations: number;
	lost: string[];
	added: string[];
}

export interface MigrationRow {
	from: string;
	to: string;
	declarations: string[];
}

export function specifier(name: string, key: string): string {
	return key === '.' ? name : `${name}/${key.slice(2)}`;
}

export function unionReport(base: Surface, current: Surface): UnionReport {
	const runtimeOf = (surface: Surface) =>
		new Set(Object.values(surface.keys).flatMap((key) => key.runtime));
	const declarationsOf = (surface: Surface) =>
		new Set(Object.values(surface.keys).flatMap((key) => Object.keys(key.declarations)));
	const baseRuntime = runtimeOf(base);
	const nowRuntime = runtimeOf(current);
	const baseDeclarations = declarationsOf(base);
	const nowDeclarations = declarationsOf(current);
	return {
		runtime: baseRuntime.size,
		declarations: baseDeclarations.size,
		lost: [
			...[...baseRuntime].filter((name) => !nowRuntime.has(name)).map((name) => `runtime ${name}`),
			...[...baseDeclarations]
				.filter((name) => !nowDeclarations.has(name))
				.map((name) => `declarations ${name}`)
		],
		added: [
			...[...nowRuntime].filter((name) => !baseRuntime.has(name)).map((name) => `runtime ${name}`),
			...[...nowDeclarations]
				.filter((name) => !baseDeclarations.has(name))
				.map((name) => `declarations ${name}`)
		]
	};
}

export function migrationRows(base: Surface, current: Surface, oldKeys: string[]): MigrationRow[] {
	return oldKeys.flatMap((from) => {
		const old = base.keys[from];
		if (!old) throw new Error(`baseline has no key ${from}`);
		const names = Object.keys(old.declarations).sort();
		const to = Object.keys(current.keys)
			.sort()
			.find((key) => {
				const now = current.keys[key];
				return (
					now !== undefined &&
					old.runtime.every((name) => now.runtime.includes(name)) &&
					names.every((name) => name in now.declarations)
				);
			});
		if (to === undefined) throw new Error(`no current key exports every name of ${from}`);
		return to === from ? [] : [{ from, to, declarations: names }];
	});
}

export function migrationTable(rows: MigrationRow[], name: string): string {
	const lines = [
		'| Old subpath | New subpath | Names |',
		'| --- | --- | --- |'
	];
	for (const row of rows) {
		const names =
			row.declarations.length <= 8
				? row.declarations.map((item) => `\`${item}\``).join(', ')
				: `all ${row.declarations.length} names`;
		lines.push(
			`| \`${specifier(name, row.from)}\` | \`${specifier(name, row.to)}\` | ${names} |`
		);
	}
	return lines.join('\n');
}

export function workerLiterals(source: string): string[] {
	return [...source.matchAll(workerUrl)]
		.map((match) => (match[1] ?? '').slice(1, -1))
		.filter((literal) => literal.includes('worker'));
}

export function dynamicImportTargets(source: string): string[] {
	return [...source.matchAll(dynamicImport)].map((match) => match[2] ?? '');
}

export function jsCandidate(literal: string): string {
	return literal.replace(templateHole, 'js');
}

function jsFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return jsFiles(path);
			return entry.name.endsWith('.js') ? [path] : [];
		})
		.sort();
}

export function checkDist(distDir: string): Check[] {
	const checks: Check[] = [];
	for (const file of jsFiles(distDir)) {
		const source = readFileSync(file, 'utf8');
		const rel = relative(distDir, file).split(sep).join('/');
		const base = dirname(file);
		for (const literal of workerLiterals(source)) {
			const target = jsCandidate(literal);
			checks.push({
				kind: 'url',
				file: rel,
				literal,
				target,
				ok: existsSync(resolve(base, target))
			});
		}
		for (const target of dynamicImportTargets(source)) {
			const js = target.endsWith('.ts') ? `${target.slice(0, -3)}.js` : target;
			checks.push({
				kind: 'import',
				file: rel,
				literal: target,
				target: js,
				ok: existsSync(resolve(base, js))
			});
		}
	}
	return checks;
}

export const portableKeys = ['./workers', './browser', './memory', './boot', './continuation'];

const nodeFolders = new Set(['node', 'folds', 'ownership', 'routing', 'slices', 'iteration']);

export interface Closure {
	files: number;
	violations: string[];
}

export interface PortableRow {
	key: string;
	types: Closure;
	runtime: Closure;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

function isBuiltin(spec: string): boolean {
	return spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0] ?? spec);
}

function scanModule(file: string): { specs: string[]; typeRefs: string[] } {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, 'utf8'),
		ts.ScriptTarget.Latest,
		false,
		file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
	);
	const specs: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specs.push(node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteral(arg)) specs.push(arg.text);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			specs.push(node.argument.literal.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return {
		specs: [...specs, ...source.referencedFiles.map((ref) => ref.fileName)],
		typeRefs: source.typeReferenceDirectives.map((ref) => ref.fileName)
	};
}

function resolveModule(from: string, spec: string, types: boolean): string | undefined {
	const stem = resolve(dirname(from), spec).replace(/(\.d)?\.[cm]?[jt]s$/, '');
	const ext = types ? '.d.ts' : '.js';
	return [`${stem}${ext}`, join(stem, `index${ext}`)].find(isFile);
}

export function closure(distDir: string, start: string, types: boolean): Closure {
	const label = (file: string) => relative(distDir, file).split(sep).join('/');
	const first = join(distDir, start);
	if (!isFile(first)) throw new Error(`${start} is not built; run bun run build`);
	const chains = new Map<string, string>([[first, label(first)]]);
	const violations: string[] = [];
	for (const file of chains.keys()) {
		const here = label(file);
		const chain = chains.get(file) ?? here;
		if (types && nodeFolders.has(here.split('/')[0] ?? '')) violations.push(`reaches ${here}: ${chain}`);
		const { specs, typeRefs } = scanModule(file);
		if (types && typeRefs.includes('node')) violations.push(`${here} references types node: ${chain}`);
		for (const spec of specs) {
			if (!spec.startsWith('.')) {
				if (isBuiltin(spec)) violations.push(`${here} imports ${spec}: ${chain}`);
				continue;
			}
			const next = resolveModule(file, spec, types);
			if (next === undefined) violations.push(`${here} imports unresolved ${spec}: ${chain}`);
			else if (!chains.has(next)) chains.set(next, `${chain} > ${label(next)}`);
		}
	}
	return { files: chains.size, violations };
}

export function portableReport(
	repo: string,
	exportsMap: Record<string, ExportValue>
): PortableRow[] {
	const distDir = join(repo, 'dist');
	return portableKeys.map((key) => {
		const value = exportsMap[key];
		if (value === undefined || typeof value === 'string') {
			throw new Error(`export ${key} needs both a types and an import entry`);
		}
		return {
			key,
			types: closure(distDir, relative(distDir, join(repo, value.types)), true),
			runtime: closure(distDir, relative(distDir, join(repo, value.import)), false)
		};
	});
}

interface PackageJson {
	name: string;
	exports: Record<string, ExportValue>;
	dependencies?: Record<string, string>;
}

function readPackage(repo: string): PackageJson {
	return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as PackageJson;
}

function readSurface(path: string): Surface {
	return JSON.parse(readFileSync(path, 'utf8')) as Surface;
}

async function packCheck(repo: string): Promise<number> {
	const pkg = readPackage(repo);
	const work = mkdtempSync(join(tmpdir(), 'folio-pack-'));
	try {
		const tarball = execFileSync(
			'npm',
			['pack', '--ignore-scripts', '--pack-destination', work],
			{ cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		)
			.trim()
			.split('\n')
			.pop();
		if (!tarball) throw new Error('npm pack printed no tarball name');
		const consumer = join(work, 'consumer');
		const modules = join(consumer, 'node_modules');
		const installed = join(modules, ...pkg.name.split('/'));
		mkdirSync(installed, { recursive: true });
		execFileSync('tar', ['-xzf', join(work, tarball), '-C', installed, '--strip-components=1']);
		for (const dep of Object.keys(pkg.dependencies ?? {})) {
			mkdirSync(dirname(join(modules, dep)), { recursive: true });
			symlinkSync(join(repo, 'node_modules', dep), join(modules, dep), 'dir');
		}
		const specs = Object.keys(pkg.exports)
			.filter((key) => key !== './package.json')
			.sort()
			.map((key) => specifier(pkg.name, key));
		const script = join(consumer, 'check.mjs');
		writeFileSync(
			script,
			`const out = {};\nfor (const spec of ${JSON.stringify(specs)}) out[spec] = Object.keys(await import(spec)).sort();\nconsole.log(JSON.stringify(out));\n`
		);
		const imported = JSON.parse(
			execFileSync(process.execPath, [script], { cwd: consumer, encoding: 'utf8' })
		) as Record<string, string[]>;
		const expected = await recordSurface(repo, pkg.exports);
		let problems = 0;
		for (const key of Object.keys(expected.keys)) {
			const spec = specifier(pkg.name, key);
			const names = imported[spec];
			const want = expected.keys[key]?.runtime ?? [];
			if (!names) {
				problems++;
				console.log(`${spec} not imported`);
			} else if (JSON.stringify(names) !== JSON.stringify(want)) {
				problems++;
				console.log(`${spec} runtime names differ from dist`);
			} else {
				console.log(`${spec} ${names.length} runtime names`);
			}
		}
		console.log(problems === 0 ? `pack ok: ${tarball}` : `${problems} problems`);
		return problems === 0 ? 0 : 1;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function usage(): number {
	console.error(
		'usage: api-surface.ts record <out.json> | diff <baseline.json> | union <baseline.json> | migration <baseline.json> <old-key>... | workers | pack-check | portable'
	);
	return 2;
}

async function main(args: string[]): Promise<number> {
	const repo = fileURLToPath(new URL('../../', import.meta.url));
	const [mode, arg] = args;
	if (mode === 'union' && arg) {
		const report = unionReport(readSurface(arg), await recordSurface(repo, readPackage(repo).exports));
		console.log(`baseline union: ${report.runtime} runtime names, ${report.declarations} declaration names`);
		const lines = [
			...report.lost.map((line) => `lost ${line}`),
			...report.added.map((line) => `added ${line}`)
		];
		for (const line of lines) console.log(line);
		const problems = lines.length;
		console.log(problems === 0 ? 'union ok, no name lost' : `${problems} problems`);
		return problems === 0 ? 0 : 1;
	}
	if (mode === 'migration' && arg) {
		const pkg = readPackage(repo);
		const rows = migrationRows(readSurface(arg), await recordSurface(repo, pkg.exports), args.slice(2));
		console.log(migrationTable(rows, pkg.name));
		return 0;
	}
	if (mode === 'pack-check') {
		return packCheck(repo);
	}
	if (mode === 'portable') {
		const rows = portableReport(repo, readPackage(repo).exports);
		let problems = 0;
		for (const row of rows) {
			for (const [kind, result] of [
				['types', row.types],
				['runtime', row.runtime]
			] as const) {
				console.log(`${row.key} ${kind}: ${result.files} files in closure`);
				for (const violation of result.violations) console.log(`  violation: ${violation}`);
				problems += result.violations.length;
			}
		}
		console.log(problems === 0 ? 'portable ok' : `${problems} portable violations`);
		return problems === 0 ? 0 : 1;
	}
	if (mode === 'workers') {
		const checks = checkDist(join(repo, 'dist'));
		for (const check of checks) {
			console.log(
				`${check.kind} ${check.file} ${check.literal} -> ${check.target} ${check.ok ? 'ok' : 'MISSING'}`
			);
		}
		const missing = checks.filter((check) => !check.ok).length;
		console.log(`${checks.length} checks, ${missing} missing`);
		return missing > 0 ? 1 : 0;
	}
	if (mode === 'record' && arg) {
		const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
		const surface = await recordSurface(repo, pkg.exports);
		writeFileSync(arg, `${JSON.stringify(surface, null, '\t')}\n`);
		for (const [key, value] of Object.entries(surface.keys)) {
			console.log(
				`${key} runtime=${value.runtime.length} declarations=${Object.keys(value.declarations).length}`
			);
		}
		console.log(`${Object.keys(surface.keys).length} keys`);
		return 0;
	}
	if (mode === 'diff' && arg) {
		const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
		const base = JSON.parse(readFileSync(arg, 'utf8')) as Surface;
		const lines = diffSurfaces(base, await recordSurface(repo, pkg.exports));
		if (lines.length === 0) {
			console.log('identical');
			return 0;
		}
		for (const line of lines) console.log(line);
		return 1;
	}
	return usage();
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
