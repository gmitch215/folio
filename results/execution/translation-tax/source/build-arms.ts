import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import binaryen from 'binaryen';
import { translate } from '../../../../scripts/research/elastic-translate.ts';

// usage: node build-arms.ts [arm ...]; INTERPRETER is the shipping interpreter module, OUT the arm directory
const source = process.env.INTERPRETER;
const out = process.env.OUT;
if (!source || !out) throw new Error('set INTERPRETER and OUT');
const bytes = readFileSync(source);
// the table sits at the first page past the stack reservation floor; the pinned stack window is the top MiB
const STACK_BASE = 37970912;
const STACK_END = STACK_BASE - 33554432;
const tableBase = Math.ceil(STACK_END / 65536) * 65536;
const common = { tableBase, staticLimit: STACK_END, stackFloor: STACK_BASE - (1 << 20) };
const arms: Record<string, any> = {
	a: { shape: 'call' },
	b: { shape: 'call', exempt: true },
	c: { shape: 'call', exempt: true, hoist: true },
	bd: { shape: 'inline', exempt: true },
	bcd: { shape: 'inline', exempt: true, hoist: true },
	trust: { shape: 'inline', exempt: true, hoist: true, trustAlign: true },
	count: { shape: 'inline', exempt: true, hoist: true, count: true }
};
mkdirSync(out, { recursive: true });
const pick = process.argv.slice(2);
for (const name of ['emit', ...Object.keys(arms)]) {
	if (pick.length && !pick.includes(name)) continue;
	const t0 = performance.now();
	let result: Uint8Array;
	let stats: unknown = {};
	if (name === 'emit') {
		const mod = binaryen.readBinary(bytes);
		result = mod.emitBinary();
		mod.dispose();
	} else {
		const r = translate(bytes, { ...common, ...arms[name] });
		result = r.bytes;
		stats = r.stats;
	}
	writeFileSync(`${out}/${name}.wasm`, result);
	const ms = Math.round(performance.now() - t0);
	const record = { name, options: arms[name] ?? {}, tableBase, ms, bytes: result.length, stats };
	writeFileSync(`${out}/${name}.json`, JSON.stringify(record, null, 1));
}
