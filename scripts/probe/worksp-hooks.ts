import { CAT, record, type Layout } from '../analyze/worksp.ts';
import { COUNTERS, type Sites } from './worksp-instrument.ts';
import { Recorder } from './worksp-recorder.ts';

export interface HookConfig {
	mode: 'count' | 'trace';
	sites?: Sites;
	layout: Layout;
	/** site ids whose refcount pattern was verified by the counter experiment */
	rcSites?: number[];
	/** count (site, address) hits for refcount-pattern sites */
	verify?: boolean;
	debug?: boolean;
	hostReplay?: 'assumed' | 'violated';
	meta: {
		module: { name: string; sha256: string };
		machine: { name: string; node: string };
	};
}

// zend_execute_data and zend_function layout on wasm32, checked by the verification probe
const FUNC = 12;
const FUNCTION_NAME = 8;
const SCOPE = 12;
const CLASS_NAME = 4;
const STRING_LEN = 16;
const STRING_VAL = 20;

export function createHooks(config: HookConfig) {
	const trace = config.mode === 'trace';
	const sites = config.sites;
	const rcOk = new Uint8Array(sites?.meta.length ?? 0);
	for (const s of config.rcSites ?? []) rcOk[s] = 1;
	let exportsRef: Record<string, WebAssembly.Global> = {};
	let memory: WebAssembly.Memory | undefined;
	let view = new Uint8Array(0);
	let rec: Recorder | undefined;
	let lastFrame = 0;
	let lastDest = 0;
	let lastSrc = 0;
	let fresh = false;
	const counts = {
		dispatches: 0,
		frameChanges: 0,
		invocations: 0,
		popped: 0,
		maxDepth: 0,
		memCopy: 0,
		memCopyBytes: 0,
		memFill: 0,
		memFillBytes: 0,
		memInit: 0,
		memInitBytes: 0,
		hostWrapped: 0,
		ldHook: 0,
		stHook: 0,
		ldHookBytes: 0,
		stHookBytes: 0,
		extentEnter: [0, 0, 0, 0]
	};
	const frames: number[] = [];
	const rcHits = new Map<number, number>();
	const siteHits = new Map<number, number>();
	const times = { begin: 0 };

	const bytes = () => {
		if (view.buffer !== memory!.buffer) view = new Uint8Array(memory!.buffer);
		return view;
	};
	const u32 = (addr: number) => {
		const b = bytes();
		return (b[addr]! | (b[addr + 1]! << 8) | (b[addr + 2]! << 16) | (b[addr + 3]! << 24)) >>> 0;
	};
	const str = (ptr: number) => {
		if (!ptr || ptr + STRING_VAL > bytes().length) return '';
		const len = Math.min(u32(ptr + STRING_LEN), 96);
		return Buffer.from(bytes().subarray(ptr + STRING_VAL, ptr + STRING_VAL + len)).toString(
			'latin1'
		);
	};
	const nameOf = (frame: number) => {
		try {
			const fn = u32(frame + FUNC);
			if (!fn) return 'frame';
			const name = str(u32(fn + FUNCTION_NAME));
			const scope = u32(fn + SCOPE);
			const cls = scope ? str(u32(scope + CLASS_NAME)) : '';
			return (cls ? `${cls}::` : '') + (name || '{main}');
		} catch {
			return 'frame';
		}
	};
	const g = (name: string) => exportsRef[`__wk_${name}`]!;
	let gn: WebAssembly.Global;
	let gspr: WebAssembly.Global;
	let gspw: WebAssembly.Global;

	const chunkHits = new Map<number, number>();
	const folio: Record<string, (...args: number[]) => any> = {
		ck(id: number) {
			if (active) chunkHits.set(id, (chunkHits.get(id) ?? 0) + 1);
		},
		ed(frame: number) {
			lastFrame = frame;
			return frame;
		},
		ci(_site: number, target: number) {
			if (rec) rec.dispatch(lastFrame, gn.value, gspr.value, gspw.value);
			else if (active) {
				counts.dispatches++;
				const top = frames[frames.length - 1];
				const again = fresh && top === lastFrame && frames.length > 1;
				fresh = false;
				if (again) {
					frames.pop();
					counts.popped++;
				}
				if (again || top !== lastFrame) {
					counts.frameChanges++;
					const at = frames.lastIndexOf(lastFrame);
					if (at >= 0) {
						counts.popped += frames.length - 1 - at;
						frames.length = at + 1;
					} else {
						frames.push(lastFrame);
						counts.invocations++;
						counts.maxDepth = Math.max(counts.maxDepth, frames.length);
					}
				}
			}
			return target;
		},
		mn(size: number, kind: number) {
			const n = size >>> 0;
			if (active) {
				if (kind === 0) {
					counts.memCopy++;
					counts.memCopyBytes += n;
				} else if (kind === 1) {
					counts.memFill++;
					counts.memFillBytes += n;
				} else {
					counts.memInit++;
					counts.memInitBytes += n;
				}
				if (rec && n > 0) {
					if (kind === 0) rec.access(lastSrc >>> 0, n, false);
					rec.access(lastDest >>> 0, n, true);
				}
			}
			return size;
		},
		en(kind: number) {
			if (!active) return;
			counts.extentEnter[kind]!++;
			if (kind === 3) {
				fresh = true;
				rec?.markEntry();
			} else rec?.enter(kind === 1 ? 'alloc' : 'out');
		},
		ex(kind: number) {
			if (rec && kind !== 3) rec.exit(kind === 1 ? 'alloc' : 'out');
		}
	};
	if (trace) {
		const meta = sites!.meta;
		const offset = sites!.offset;
		folio.ld = (ptr: number, site: number) => {
			if (rec) {
				const m = meta[site]!;
				counts.ldHook++;
				if (config.debug) siteHits.set(site, (siteHits.get(site) ?? 0) + 1);
				counts.ldHookBytes += m & 15;
				rec.access(
					(ptr >>> 0) + offset[site]!,
					m & 15,
					false,
					rcOk[site] ? CAT.rc : CAT.plain
				);
				if (config.verify && m >> 5) hit(site, ptr, offset[site]!);
			}
			return ptr;
		};
		folio.st = (ptr: number, site: number) => {
			if (rec) {
				const m = meta[site]!;
				counts.stHook++;
				if (config.debug) siteHits.set(site, (siteHits.get(site) ?? 0) + 1);
				counts.stHookBytes += m & 15;
				rec.access(
					(ptr >>> 0) + offset[site]!,
					m & 15,
					true,
					rcOk[site] ? CAT.rc : CAT.plain
				);
				if (config.verify && m >> 5) hit(site, ptr, offset[site]!);
			}
			return ptr;
		};
		folio.md = (ptr: number) => {
			lastDest = ptr;
			return ptr;
		};
		folio.ms = (ptr: number) => {
			lastSrc = ptr;
			return ptr;
		};
	}
	const hit = (site: number, ptr: number, off: number) => {
		const key = ((ptr >>> 0) + off) * 2 ** 21 + site;
		rcHits.set(key, (rcHits.get(key) ?? 0) + 1);
	};
	let active = false;

	/** host imports: counted as sequential nodes; invoke_* trampolines are not host effects */
	function wrap(imports: Record<string, Record<string, any>>) {
		for (const [ns, table] of Object.entries(imports)) {
			if (ns === 'folio') continue;
			for (const [name, fn] of Object.entries(table)) {
				if (typeof fn !== 'function' || name.startsWith('invoke_')) continue;
				table[name] =
					name === 'emscripten_memcpy_js'
						? (dest: number, src: number, n: number) => {
								if (rec) {
									rec.access(src >>> 0, n >>> 0, false);
									rec.access(dest >>> 0, n >>> 0, true);
									rec.host();
								}
								return fn(dest, src, n);
							}
						: (...args: any[]) => {
								if (active) counts.hostWrapped++;
								rec?.host();
								return fn(...args);
							};
			}
		}
	}

	return {
		imports: folio,
		wrap,
		attach(instance: WebAssembly.Instance, mem: WebAssembly.Memory) {
			exportsRef = instance.exports as any;
			memory = mem;
			view = new Uint8Array(mem.buffer);
			gn = g('n');
			gspr = g('spr');
			gspw = g('spw');
		},
		snapshot() {
			return Object.fromEntries(COUNTERS.map((c) => [c, g(c).value as number]));
		},
		nameOf,
		begin() {
			active = true;
			frames.length = 0;
			frames.push(-1);
			rcHits.clear();
			for (const k of Object.keys(counts)) {
				if (k === 'extentEnter') counts.extentEnter = [0, 0, 0, 0];
				else (counts as any)[k] = 0;
			}
			if (trace) {
				rec = new Recorder({ layout: config.layout, nameOf });
				rec.start(gn.value, gspr.value, gspw.value);
			}
			times.begin = performance.now();
			return times.begin;
		},
		end(input: { id: string; sha256?: string }, extra: Record<string, unknown> = {}) {
			const wall = performance.now() - times.begin;
			if (!rec) {
				active = false;
				return { counts: { ...counts }, wallMs: wall };
			}
			const t0 = performance.now();
			const ws = rec.finish(gn.value, gspr.value, gspw.value);
			const recorded = rec.stats;
			rec = undefined;
			active = false;
			const t1 = performance.now();
			const result = record(
				ws,
				{
					module: config.meta.module,
					input,
					machine: config.meta.machine,
					granularity: 'php-userfunc',
					events: { ...counts, ...recorded, extentEnter: undefined } as any,
					assumptions: [
						'one granule is 8 bytes, so two accesses to one 8-byte word conflict',
						'a call is a change of execute_data at the opcode dispatch site',
						'work is binaryen IR nodes executed, counted per straight-line chunk',
						'allocator class is the dynamic extent of the exported allocator entry points',
						'host_buffered assumes every host call can be replayed in order',
						'rename_alloc assumes per-segment arenas; cross-arena frees are not tracked',
						'speculation: write-after-read and write-after-write vanish, reads replay if the writer finishes after the reader starts'
					],
					unmeasured: [
						'writes made by host imports other than emscripten_memcpy_js',
						'allocator work inlined into callers outside the exported entry points',
						'time: instruction counts are not durations, host calls have no cost',
						'one input on one machine'
					]
				},
				{ hostReplay: config.hostReplay, ...(extra as any) }
			);
			return {
				record: result,
				counts: { ...counts },
				stats: recorded,
				graph: { nodes: ws.nodeCount, edges: ws.ePred.n, pages: undefined },
				rcHits: config.verify ? [...rcHits] : undefined,
				chunkHits: config.debug ? [...chunkHits] : undefined,
				siteHits: config.debug ? [...siteHits] : undefined,
				wallMs: wall,
				analyzeMs: performance.now() - t1,
				finishMs: t1 - t0
			};
		}
	};
}
