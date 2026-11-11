import binaryen from 'binaryen';
import { existsSync, readFileSync } from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { hostMath, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, outDir, specs } from './c21-kernels.ts';
import { BASES, INSERTS, moduleOf, routeMatches } from './ownership-modules.ts';

// usage: ownership-adversary.ts [alloc OUT.jsonl] ; mutate hand modules and real drivers, certify, and compare the
// private-window route with the serial run for every accepted mutant; `alloc` runs the allocator mutants instead
if (process.argv[2] === 'alloc') await import('./ownership-alloc-adversary.ts');
if (process.argv[2] === 'prefix') await import('./ownership-prefix-adversary.ts');
if (process.argv[2] === 'kissfft') await import('./ownership-kissfft-adversary.ts');
interface Row {
	label: string;
	operator: string;
	expect: string[];
	outcome: string;
	truth: 'equal' | 'differs' | 'skipped';
	wat?: string;
}

const rows: Row[] = [];
const SEEDS = [1, 2, 3, 4, 5, 6];
const NEVER = 'any';

function classify(
	label: string,
	operator: string,
	expect: string[],
	bytes: Uint8Array,
	truth: (c: OwnershipCertificate) => boolean,
	always: boolean,
	wat?: () => string
) {
	const r = certifyOwnership(bytes);
	if (r.kind === 'refusal') {
		let t: Row['truth'] = 'skipped';
		if (always) {
			// a refused mutant still runs against the window its pass one would derive, when there is one
			t = 'skipped';
		}
		rows.push({ label, operator, expect, outcome: r.reason, truth: t });
		return;
	}
	const equal = truth(r);
	rows.push({
		label,
		operator,
		expect,
		outcome: 'certificate',
		truth: equal ? 'equal' : 'differs',
		wat: equal ? undefined : wat?.()
	});
}

// #region hand modules

const wrap = (statement: string) =>
	`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;

for (const [name, base] of Object.entries(BASES)) {
	const run = (
		statements: string[],
		insert: string | undefined,
		label: string,
		operator: string,
		expect: string[]
	) => {
		let bytes: Uint8Array;
		try {
			bytes = moduleOf(statements, insert);
		} catch {
			return;
		}
		classify(
			label,
			operator,
			expect,
			bytes,
			(c) => routeMatches(bytes, c.windows, SEEDS),
			true,
			() => statements.join('\n')
		);
	};
	run(base, undefined, `${name}`, 'base', ['none']);
	for (let i = 0; i < base.length; i++) {
		run(
			base.filter((_, k) => k !== i),
			undefined,
			`${name}-delete-${i}`,
			'delete',
			[NEVER]
		);
		run(
			base.map((s, k) => (k === i ? wrap(s) : s)),
			undefined,
			`${name}-cond-${i}`,
			'conditional',
			[NEVER]
		);
		if (i + 1 < base.length) {
			const swapped = [...base];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
			run(swapped, undefined, `${name}-swap-${i}`, 'swap', [NEVER]);
		}
	}
	for (const [insert, add] of Object.entries(INSERTS))
		for (const at of [0, Math.floor(base.length / 2), base.length]) {
			const statements = [
				...base.slice(0, at),
				...(add.text ? [add.text] : []),
				...base.slice(at)
			];
			run(statements, insert, `${name}-${insert}-${at}`, insert, add.expect);
		}
}

// #endregion

// #region real drivers

const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

function storeSites(text: string) {
	const sites: [number, number][] = [];
	const re = /\(i(?:32|64)\.store(?:8|16|32)?[ \n]/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let depth = 0;
		for (let at = m.index; at < text.length; at++) {
			if (text[at] === '(') depth++;
			else if (text[at] === ')' && --depth === 0) {
				sites.push([m.index, at + 1]);
				break;
			}
		}
	}
	return sites;
}

function assembleText(text: string): Uint8Array | undefined {
	try {
		const m = binaryen.parseText(text);
		m.setFeatures(binaryen.Features.All & ~compact);
		const ok = m.validate();
		const bytes = ok ? Uint8Array.from(m.emitBinary()) : undefined;
		m.dispose();
		return bytes;
	} catch {
		return undefined;
	}
}

function driverTruth(id: string) {
	const spec = specs.find((s) => s.id === id)!;
	const n = 6;
	const records = recordsOf(spec, n);
	const layout = layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const pages = layout.pages + 8;
	return (bytes: Uint8Array, windows: { low: number; end: number }[]) => {
		const run = (route: boolean) => {
			const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
			const view = new Uint8Array(memory.buffer);
			const exports = new WebAssembly.Instance(
				new WebAssembly.Module(Uint8Array.from(bytes)),
				{
					env: { memory, ...hostMath() }
				}
			).exports as Record<string, Function>;
			writeRecords(memory, spec, layout, records);
			for (const w of windows)
				for (let a = w.low; a < w.end; a++) view[a] = (a * 7 + 3) & 255;
			const base = windows.map((w) => view.slice(w.low, w.end));
			let trapped = -1;
			for (let i = 0; i < n; i++) {
				if (route) windows.forEach((w, k) => view.set(base[k]!, w.low));
				try {
					exports.bulk!(layout.table + 16 * i, 1, layout.out + spec.slot * i);
				} catch {
					trapped = i;
					break;
				}
			}
			return { trapped, view };
		};
		const a = run(false);
		const b = run(true);
		if (a.trapped !== b.trapped) return false;
		if (a.trapped >= 0) return true;
		for (let at = 0; at < a.view.length; at++) if (a.view[at] !== b.view[at]) return false;
		return true;
	};
}

const DRIVER_IDS = ['aes-cbc-decrypt-shared', 'sha256-shared', 'jsmn-parse-shared'];
const PER_DRIVER = Number(process.env.OWNERSHIP_DRIVER_MUTANTS ?? 40);
for (const id of DRIVER_IDS) {
	const file = `${outDir}/${id}.wasm`;
	if (!existsSync(file)) continue;
	const original = new Uint8Array(readFileSync(file));
	const module = binaryen.readBinary(original);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const truth = driverTruth(id);
	const sites = storeSites(text);
	const picks: number[] = [];
	const step = Math.max(1, Math.floor(sites.length / PER_DRIVER));
	for (let k = 0; k < sites.length && picks.length < PER_DRIVER; k += step) picks.push(k);
	const window = certifyOwnership(original);
	const gate = '(i32.and (i32.load8_u (i32.const 66060)) (i32.const 1))';
	const edit = (k: number, make: (form: string) => string) => {
		const [a, b] = sites[k]!;
		return text.slice(0, a) + make(text.slice(a, b)) + text.slice(b);
	};
	const operators: Record<string, (form: string) => string> = {
		delete: () => '(nop)',
		conditional: (form) => `(if ${gate} (then ${form}))`,
		trap: (form) => `(block ${form} (if ${gate} (then (unreachable))))`,
		'fill-after': (form) =>
			`(block ${form} (memory.fill (i32.const 66048) (i32.const 0) (i32.const 64)))`,
		'address-leak': (form) => `(block ${form} (i32.store (i32.const 66048) (i32.const 66048)))`
	};
	for (const k of picks)
		for (const [operator, make] of Object.entries(operators)) {
			if (rows.length > 100000) break;
			const bytes = assembleText(edit(k, make));
			if (!bytes) continue;
			classify(
				`${id}-${operator}-${k}`,
				operator,
				[NEVER],
				bytes,
				(c) => truth(bytes, c.windows),
				false
			);
		}
	void window;
}

// #endregion

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrong = accepted.filter((r) => r.truth === 'differs');
const unexplainedAccepted = accepted.filter(
	(r) => r.truth === 'equal' && !r.expect.includes('none') && !r.expect.includes(NEVER)
);
const unexplainedRefused = refused.filter(
	(r) => !r.expect.includes(NEVER) && !r.expect.includes(r.outcome)
);
const reasons = new Map<string, number>();
for (const r of refused) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: rows.length,
			accepted: accepted.length,
			refused: refused.length,
			acceptedAndWrong: wrong.length,
			unexplainedAccepted: unexplainedAccepted.length,
			unexplainedRefused: unexplainedRefused.length,
			topReasons: [...reasons].sort((a, b) => b[1] - a[1]),
			handMutants: rows.filter((r) => !r.label.includes('-shared-')).length
		},
		null,
		1
	)
);
for (const r of wrong) console.log('FALSE CERTIFICATE', r.label, '\n' + (r.wat ?? ''));
for (const r of unexplainedAccepted) console.log('unexplained accepted', r.label, r.operator);
for (const r of unexplainedRefused)
	console.log(
		'unexplained refused',
		r.label,
		r.operator,
		r.outcome,
		'expected',
		r.expect.join('|')
	);
