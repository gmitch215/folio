import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EnumeratedFunction {
	line: number;
	name: string;
	returnType: string;
	signature: string;
	parameters: string;
	parameterCount: number;
	nonConstPointerParams: string[];
	hasBody: boolean;
	internal: boolean;
}

export interface UnparsedItem {
	line: number;
	text: string;
}

export interface ExcludedItem {
	line: number;
	text: string;
	macro: string;
	reason: 'non-public-macro';
}

export interface HeaderEnumeration {
	path: string;
	sha256: string;
	functions: EnumeratedFunction[];
	unparsed: UnparsedItem[];
	excluded: ExcludedItem[];
}

const limits = [
	'token scan, no C parser: preprocessor conditionals are not evaluated, so both branches are scanned',
	'function-like macros and declarations built by macros are listed as unparsed with their line',
	'typedefs, struct and enum bodies, and variables are not reported',
	'nonConstPointerParams is a mechanical candidate list (any pointer parameter without const), not a choice of driver',
	'leading all-caps tokens are read as export macros and removed before parsing; a macro argument is the return type when the declaration has none, and a lone all-caps type (BOOL f(void)) is kept as the return type',
	'a declaration whose leading macro token contains PRIVATE or INTERNAL is excluded with reason non-public-macro, not listed as a function'
];

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

// comments become spaces and literal contents become spaces; newlines are kept so line numbers hold
function scrub(text: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, ' ');
	return text.replace(
		/\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/g,
		(match) => {
			if (match.startsWith('//') || match.startsWith('/*')) return blank(match);
			const quote = match.charAt(0);
			const closed = match.length > 1 && match.endsWith(quote);
			return quote + blank(match.slice(1, closed ? -1 : undefined)) + (closed ? quote : '');
		}
	);
}

function matchingIndex(text: string, open: number, pair: [string, string]): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === pair[0]) depth++;
		else if (text[i] === pair[1] && --depth === 0) return i;
	}
	return -1;
}

function splitParams(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of text) {
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

// leading all-caps export macros, each optionally with an argument
const exportMacros = /^((?:[A-Z_][A-Z0-9_]*(?:\s*\([^()]*\))?\s+)+)(?=[A-Za-z_])/;

function splitDeclarator(decl: string): { name: string; returnType: string } {
	const open = decl.indexOf('(');
	const prefix = open < 0 ? '' : decl.slice(0, open).trim();
	const name = /([A-Za-z_]\w*)$/.exec(prefix)?.[1] ?? '';
	return { name, returnType: name ? prefix.slice(0, prefix.length - name.length).trim() : '' };
}

// a macro argument is the return type; a lone all-caps type stays
function declarationText(norm: string): string {
	const lead = exportMacros.exec(norm);
	if (!lead) return norm;
	const rest = norm.slice(lead[0].length);
	if (splitDeclarator(rest).returnType) return rest;
	const macroArg = [...(lead[1] ?? '').matchAll(/\(([^()]*)\)/g)].at(-1)?.[1]?.trim();
	return macroArg ? `${macroArg} ${rest}` : norm;
}

export function enumerateHeader(path: string, bytes: Uint8Array): HeaderEnumeration {
	const text = Buffer.from(bytes).toString('utf8').replace(/\r\n?/g, '\n');
	const clean = scrub(text);
	const offsets: number[] = [];
	for (let i = 0; i < clean.length; i++) if (clean[i] === '\n') offsets.push(i);
	const lineOf = (index: number) => {
		let lo = 0;
		let hi = offsets.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((offsets[mid] ?? 0) < index) lo = mid + 1;
			else hi = mid;
		}
		return lo + 1;
	};

	const functions: EnumeratedFunction[] = [];
	const unparsed: UnparsedItem[] = [];
	const excluded: ExcludedItem[] = [];

	const classify = (raw: string, line: number, hasBody: boolean) => {
		const norm = raw.replace(/\s+/g, ' ').trim();
		if (!norm || /^typedef\b/.test(norm) || !norm.includes('(')) return;
		const lead = exportMacros.exec(norm)?.[1]?.trim() ?? '';
		if (/PRIVATE|INTERNAL/.test(lead)) {
			excluded.push({ line, text: norm, macro: lead, reason: 'non-public-macro' });
			return;
		}
		const text = declarationText(norm);
		const open = text.indexOf('(');
		const { name, returnType } = splitDeclarator(text);
		const close = open < 0 ? -1 : matchingIndex(text, open, ['(', ')']);
		const tail = close < 0 ? '' : text.slice(close + 1).trim();
		const declarator = text.slice(open + 1).trimStart();
		if (
			!name ||
			!returnType ||
			close < 0 ||
			/^[*^(]/.test(declarator) ||
			(tail !== '' && !tail.startsWith('__attribute__'))
		) {
			unparsed.push({ line, text: norm });
			return;
		}
		const parameters = text.slice(open + 1, close).trim();
		const list = parameters === '' || parameters === 'void' ? [] : splitParams(parameters);
		functions.push({
			line,
			name,
			returnType,
			signature: norm,
			parameters,
			parameterCount: list.length,
			nonConstPointerParams: list.filter((p) => p.includes('*') && !/\bconst\b/.test(p)),
			hasBody,
			internal: /\bstatic\b/.test(returnType)
		});
	};

	const afterBlock = (open: number) => {
		const close = matchingIndex(clean, open, ['{', '}']);
		return close < 0 ? clean.length : close + 1;
	};
	let i = 0;
	let stmt = '';
	let stmtStart = -1;
	let parens = 0;
	while (i < clean.length) {
		const c = clean.charAt(i);
		if (c === '#' && /^\s*$/.test(clean.slice(clean.lastIndexOf('\n', i - 1) + 1, i))) {
			const start = i;
			let directive = '';
			while (i < clean.length && clean[i] !== '\n') {
				if (clean[i] === '\\' && clean[i + 1] === '\n') {
					i += 2;
					directive += ' ';
					continue;
				}
				directive += clean[i];
				i++;
			}
			const norm = directive.replace(/\s+/g, ' ').trim();
			// object-like macros with a declaration body are unparsed
			if (/^#\s*define\s+\w+\(/.test(norm) || /^#\s*define\s+\w+\s.*\(.*;$/.test(norm))
				unparsed.push({ line: lineOf(start), text: norm });
			continue;
		}
		if (c === '{' && parens === 0) {
			const header = stmt.trim();
			if (/^extern\b/.test(header)) {
				stmt = '';
				stmtStart = -1;
				i++;
				continue;
			}
			if (header.endsWith(')') && header.includes('(') && !/^typedef\b/.test(header)) {
				classify(header, lineOf(stmtStart), true);
				stmt = '';
				stmtStart = -1;
				i = afterBlock(i);
				continue;
			}
			if (stmtStart < 0) stmtStart = i;
			stmt += '{}';
			i = afterBlock(i);
			continue;
		}
		if (c === '}') {
			i++;
			continue;
		}
		if (c === ';' && parens === 0) {
			classify(stmt, lineOf(stmtStart), false);
			stmt = '';
			stmtStart = -1;
			i++;
			continue;
		}
		if (c === '(') parens++;
		else if (c === ')') parens--;
		if (stmt === '') {
			if (/\s/.test(c)) {
				i++;
				continue;
			}
			stmtStart = i;
		}
		stmt += c;
		i++;
	}

	return { path, sha256: sha256(bytes), functions, unparsed, excluded };
}

const SCRIPT = fileURLToPath(import.meta.url);

export function enumerateProject(projectDir: string, headers: string[]) {
	return {
		schema: 1,
		script: {
			path: 'scripts/research/corpus-enumerate.ts',
			sha256: sha256(readFileSync(SCRIPT))
		},
		project: basename(projectDir),
		limits,
		headers: headers.map((header) =>
			enumerateHeader(header, readFileSync(join(projectDir, header)))
		)
	};
}

if (import.meta.main) {
	const [projectDir, ...headers] = process.argv.slice(2);
	if (!projectDir || !headers.length)
		throw new Error('usage: corpus-enumerate.ts <project dir> <header path...>');
	console.log(JSON.stringify(enumerateProject(projectDir, headers), null, '\t'));
}
