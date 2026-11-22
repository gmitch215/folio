import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node classify-globals.mjs <module.wasm> [out.json]');
const bytes = new Uint8Array(readFileSync(wasmPath));
const outPath = process.argv[3] ?? resolve(here, 'runs', 'globals.json');

let pos = 0;
const u8 = () => bytes[pos++];
function uleb() {
	let result = 0;
	let shift = 0;
	for (;;) {
		const b = bytes[pos++];
		result += (b & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(b & 0x80)) return result;
	}
}
function sleb() {
	let result = 0;
	let shift = 0;
	let b;
	do {
		b = bytes[pos++];
		result += (b & 0x7f) * 2 ** shift;
		shift += 7;
	} while (b & 0x80);
	if (shift < 53 && b & 0x40) result -= 2 ** shift;
	return result;
}
const name = () => {
	const n = uleb();
	const s = Buffer.from(bytes.subarray(pos, pos + n)).toString('utf8');
	pos += n;
	return s;
};

if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
	throw new Error('not a wasm module');
}
pos = 8;

const sections = {};
while (pos < bytes.length) {
	const id = u8();
	const size = uleb();
	sections[id] = { start: pos, end: pos + size };
	pos += size;
}

// imports shift the function and global index spaces
let importedFuncs = 0;
let importedGlobals = 0;
const importedGlobalTypes = [];
if (sections[2]) {
	pos = sections[2].start;
	const n = uleb();
	for (let i = 0; i < n; i++) {
		name();
		name();
		const kind = u8();
		if (kind === 0) {
			uleb();
			importedFuncs++;
		} else if (kind === 1) {
			u8();
			const flags = u8();
			uleb();
			if (flags & 1) uleb();
		} else if (kind === 2) {
			const flags = u8();
			uleb();
			if (flags & 1) uleb();
		} else if (kind === 3) {
			importedGlobalTypes.push(u8());
			u8();
			importedGlobals++;
		} else {
			throw new Error(`unknown import kind ${kind}`);
		}
	}
}

// internal globals, with their init values
const globals = [];
if (sections[6]) {
	pos = sections[6].start;
	const n = uleb();
	for (let i = 0; i < n; i++) {
		const type = u8();
		const mutable = u8();
		const op = u8();
		let init = null;
		if (op === 0x41 || op === 0x42) init = sleb();
		else if (op === 0x23) init = { globalGet: uleb() };
		else throw new Error(`unhandled global init opcode 0x${op.toString(16)}`);
		pos++;
		globals.push({ index: importedGlobals + i, type, mutable: mutable === 1, init });
	}
}

// export names for the sites
const exportName = new Map();
const exportedGlobal = new Map();
if (sections[7]) {
	pos = sections[7].start;
	const n = uleb();
	for (let i = 0; i < n; i++) {
		const nm = name();
		const kind = u8();
		const idx = uleb();
		if (kind === 0) exportName.set(idx, nm);
		if (kind === 3) exportedGlobal.set(idx, nm);
	}
}

// one body per defined function, after the imported functions
const MUTABLE = globals.filter((g) => g.mutable).map((g) => g.index);
const sites = new Map(MUTABLE.map((g) => [g, []]));

function blocktype() {
	const b = bytes[pos];
	if (b === 0x40 || (b >= 0x6f && b <= 0x7f)) {
		pos++;
		return;
	}
	sleb();
}

function skipInstr(op) {
	switch (op) {
		case 0x02:
		case 0x03:
		case 0x04:
		case 0x06:
			blocktype();
			return;
		case 0x0c:
		case 0x0d:
		case 0x10:
		case 0x12:
		case 0x14:
		case 0x15:
		case 0x07:
		case 0x08:
		case 0x09:
		case 0x18:
		case 0x20:
		case 0x21:
		case 0x22:
		case 0x25:
		case 0x26:
		case 0xd2:
		case 0xd4:
		case 0xd5:
			uleb();
			return;
		case 0x0e: {
			const n = uleb();
			for (let i = 0; i <= n; i++) uleb();
			return;
		}
		case 0x11:
		case 0x13:
			uleb();
			uleb();
			return;
		case 0x1c: {
			const n = uleb();
			for (let i = 0; i < n; i++) u8();
			return;
		}
		case 0x41:
			sleb();
			return;
		case 0x42:
			sleb();
			return;
		case 0x43:
			pos += 4;
			return;
		case 0x44:
			pos += 8;
			return;
		case 0x3f:
		case 0x40:
			u8();
			return;
		case 0xd0:
			sleb();
			return;
		case 0xfc: {
			const sub = uleb();
			if (sub <= 7) return;
			if (sub === 8) {
				uleb();
				u8();
			} else if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) uleb();
			else if (sub === 10) {
				u8();
				u8();
			} else if (sub === 11) u8();
			else if (sub === 12 || sub === 14) {
				uleb();
				uleb();
			} else throw new Error(`unhandled 0xfc ${sub}`);
			return;
		}
		default:
			if (op >= 0x28 && op <= 0x3e) {
				uleb();
				uleb();
				return;
			}
			if (op >= 0x45 && op <= 0xc4) return;
			if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f) return;
			if (op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1 || op === 0x19) return;
			if (op === 0xd3) return;
			if (op === 0x16 || op === 0x17)
				throw new Error(`unhandled opcode 0x${op.toString(16)}`);
			throw new Error(`unhandled opcode 0x${op.toString(16)} at ${pos - 1}`);
	}
}

const codeStart = sections[10] ? sections[10].start : 0;
pos = codeStart;
const bodies = uleb();
const report = [];
for (let f = 0; f < bodies; f++) {
	const size = uleb();
	const bodyEnd = pos + size;
	const funcIndex = importedFuncs + f;
	const localGroups = uleb();
	for (let i = 0; i < localGroups; i++) {
		uleb();
		u8();
	}
	const written = new Set();
	const local = new Map(MUTABLE.map((g) => [g, { gets: 0, sets: 0, readBeforeWrite: 0 }]));
	while (pos < bodyEnd) {
		const op = u8();
		if (op === 0x23 || op === 0x24) {
			const g = uleb();
			if (local.has(g)) {
				const t = local.get(g);
				if (op === 0x23) {
					t.gets++;
					if (!written.has(g)) t.readBeforeWrite++;
				} else {
					t.sets++;
					written.add(g);
				}
				sites.get(g).push({
					func: funcIndex,
					export: exportName.get(funcIndex) ?? null,
					op: op === 0x23 ? 'get' : 'set'
				});
			}
		} else skipInstr(op);
	}
	for (const [g, t] of local) {
		if (t.gets || t.sets) {
			report.push({
				global: g,
				func: funcIndex,
				export: exportName.get(funcIndex) ?? null,
				gets: t.gets,
				sets: t.sets,
				readBeforeWrite: t.readBeforeWrite
			});
		}
	}
	pos = bodyEnd;
}

const summary = MUTABLE.map((g) => {
	const s = sites.get(g);
	const readFirst = report.filter((r) => r.global === g && r.readBeforeWrite > 0);
	return {
		global: g,
		init: globals.find((x) => x.index === g).init,
		getSites: s.filter((x) => x.op === 'get').length,
		setSites: s.filter((x) => x.op === 'set').length,
		functionsReadingBeforeWriting: readFirst.length,
		exportedAs: exportedGlobal.get(g) ?? null,
		scratch: readFirst.length === 0 && s.some((x) => x.op === 'get'),
		firstReadBeforeWriteSites: readFirst.slice(0, 8).map((r) => ({
			func: r.func,
			export: r.export,
			readBeforeWrite: r.readBeforeWrite
		}))
	};
});

const out = {
	module: wasmPath.split('/').pop(),
	bytes: bytes.length,
	importedFuncs,
	importedGlobals,
	mutable: MUTABLE,
	summary,
	perFunction: report
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, '\t') + '\n');
console.log(JSON.stringify(summary, null, '\t'));
console.log(`wrote ${outPath}`);
