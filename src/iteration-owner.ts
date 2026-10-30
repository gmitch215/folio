import binaryen from 'binaryen';
import type { IterationRoute } from './extract.ts';
import { restoreImportOrder } from './import-order.ts';

/** Why the iteration route is not used, in `ExecutionReport.reason`. */
export type IterationReason =
	| 'no-arena'
	| 'memory-size-observed'
	| 'import-order'
	| 'workers-unavailable'
	| 'trip-zero'
	| 'no-admission'
	| 'log-exhausted'
	| 'frame-carried dependence';

/** The owner module with its loop handed to `iterate`, and what the host needs to bind it. */
export interface IterationOwner {
	module: Uint8Array;
	/** import module of the host function; the function is `iterate` */
	namespace: string;
	/** the owner local passed as each argument of `iterate`, in order */
	locals: number[];
	/** export of the owner's stack global, when the module has one */
	stackExport?: string;
	/** the memory import, as declared by the original module */
	memory: { module: string; name: string; initial: number; maximum?: number };
}

const PAGE_LIMIT = 65536;

function uleb(value: number): number[] {
	const out: number[] = [];
	do {
		let byte = value % 128;
		value = Math.floor(value / 128);
		if (value) byte |= 128;
		out.push(byte);
	} while (value);
	return out;
}

/** Reads the one imported memory's limits from the import section. */
function importedMemory(bytes: Uint8Array) {
	let at = 8;
	const uint = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[at++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	const name = () => {
		const length = uint();
		const text = new TextDecoder().decode(bytes.subarray(at, at + length));
		at += length;
		return text;
	};
	const reference = () => {
		const type = bytes[at++]!;
		if (type === 0x63 || type === 0x64) uint();
	};
	while (at < bytes.length) {
		const header = at;
		const id = bytes[at++]!;
		const length = uint();
		const sectionEnd = at + length;
		const sectionStart = at;
		if (id !== 2) {
			at = sectionEnd;
			continue;
		}
		const count = uint();
		const found: {
			module: string;
			name: string;
			flags: number;
			initial: number;
			maximum?: number;
			limits: [number, number];
			header: number;
			body: [number, number];
		}[] = [];
		for (let i = 0; i < count; i++) {
			const module = name();
			const base = name();
			const kind = bytes[at++]!;
			if (kind === 0) uint();
			else if (kind === 1) {
				reference();
				const flags = uint();
				uint();
				if (flags & 1) uint();
			} else if (kind === 2) {
				const from = at;
				const flags = uint();
				const initial = uint();
				const maximum = flags & 1 ? uint() : undefined;
				found.push({
					module,
					name: base,
					flags,
					initial,
					maximum,
					limits: [from, at],
					header,
					body: [sectionStart, sectionEnd]
				});
			} else if (kind === 3) {
				reference();
				at++;
			} else if (kind === 4) {
				at++;
				uint();
			} else throw new TypeError('unsupported import descriptor');
		}
		return found;
	}
	return [];
}

/** Rewrites the memory import limits to shared with the largest maximum. */
function shareMemory(bytes: Uint8Array, memory: ReturnType<typeof importedMemory>[number]) {
	const { limits, header, body } = memory;
	const content = [
		...bytes.subarray(body[0], limits[0]),
		3,
		...uleb(memory.initial),
		...uleb(PAGE_LIMIT),
		...bytes.subarray(limits[1], body[1])
	];
	return Uint8Array.from([
		...bytes.subarray(0, header),
		2,
		...uleb(content.length),
		...content,
		...bytes.subarray(body[1])
	]);
}

const refusal = (reason: IterationReason, detail: string) => ({ reason, detail });

/**
 * Builds the owner module of an iteration route: the memory import is shared, and the one loop
 * of the owner function becomes `if (iterate(entry locals...)) { final values } else { the loop }`.
 * The host function returns 1 after it ran every iteration and 0 to leave the original loop to
 * run in the owner. A refusal names its reason and never throws.
 */
export function iterationOwner(
	original: Uint8Array,
	route: IterationRoute,
	stack?: string
): { owner: IterationOwner } | { reason: IterationReason; detail: string } {
	let module: binaryen.Module | undefined;
	try {
		if (!route.eligible || !route.owner || !route.trip)
			return refusal('no-arena', 'route is not eligible');
		const memories = importedMemory(original);
		if (memories.length !== 1)
			return refusal('no-arena', 'iteration needs exactly one imported memory');
		const declared = memories[0]!;
		if (declared.flags & ~3) return refusal('no-arena', 'wasm64 or unsupported memory limits');
		const shared = shareMemory(original, declared);
		module = binaryen.readBinary(shared);
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		module.setFeatures(binaryen.Features.All & ~compactImports);
		const m = module;
		if (m.getMemoryInfo().is64) return refusal('no-arena', 'wasm64 memory');
		if (/\bmemory\.(size|grow)\b/.test(m.emitText()))
			return refusal(
				'memory-size-observed',
				'the module executes memory.size or memory.grow, which would observe the arena'
			);
		const owner = m.getFunction(route.owner);
		if (!owner) return refusal('no-arena', `owner ${route.owner} not found`);
		const f = binaryen.getFunctionInfo(owner);
		const types = [...binaryen.expandType(f.params), ...f.vars];
		const id = (e: number) => binaryen.getExpressionId(e);
		const locate = (
			e: number
		): { parent?: number; index: number; loop: number } | undefined => {
			if (id(e) === binaryen.LoopId) return { index: -1, loop: e };
			if (id(e) !== binaryen.BlockId) return;
			const kids: number[] = (binaryen.getExpressionInfo(e) as any).children;
			for (let i = 0; i < kids.length; i++) {
				if (id(kids[i]!) === binaryen.LoopId)
					return { parent: e, index: i, loop: kids[i]! };
				const inner = locate(kids[i]!);
				if (inner) return inner;
			}
		};
		const place = locate(f.body);
		if (!place) return refusal('no-arena', 'loop not found in the owner');

		const imports = WebAssembly.Module.imports(
			new WebAssembly.Module(Uint8Array.from(original))
		);
		let namespace = '__folio_iteration';
		while (imports.some((item) => item.module === namespace)) namespace += '_';
		let call = '__folio_iterate';
		while (m.getFunction(call)) call += '_';
		const locals = route.locals.map((item) => item.local);
		m.addFunctionImport(
			call,
			namespace,
			'iterate',
			binaryen.createType(locals.map((local) => types[local]!)),
			binaryen.i32
		);
		const get = (local: number) => m.local.get(local, types[local]!);
		const counter = route.trip.local;
		const done: number[] = [];
		for (const item of route.locals)
			if (item.kind === 'stride')
				done.push(
					m.local.set(
						item.local,
						m.i32.add(
							get(item.local),
							m.i32.mul(get(counter), m.i32.const(item.stride! | 0))
						)
					)
				);
		done.push(m.local.set(counter, m.i32.const(0)));
		const replacement = m.if(
			m.call(
				call,
				locals.map((local) => get(local)),
				binaryen.i32
			),
			m.block(null, done),
			place.loop
		);
		const raw = binaryen as any;
		if (place.parent) raw._BinaryenBlockSetChildAt(place.parent, place.index, replacement);
		else raw._BinaryenFunctionSetBody(owner, replacement);
		let stackExport: string | undefined;
		if (stack !== undefined && m.getGlobal(stack)) {
			stackExport = '__folio_owner_stack';
			while (m.getExport(stackExport)) stackExport += '_';
			m.addGlobalExport(stack, stackExport);
		}
		if (!m.validate()) throw new Error('invalid iteration owner');
		let bytes: Uint8Array;
		try {
			bytes = restoreImportOrder(m.emitBinary(), imports);
		} catch (error) {
			return refusal(
				'import-order',
				`import order cannot be kept: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		new WebAssembly.Module(Uint8Array.from(bytes));
		return {
			owner: {
				module: bytes,
				namespace,
				locals,
				stackExport,
				memory: {
					module: declared.module,
					name: declared.name,
					initial: declared.initial,
					maximum: declared.maximum
				}
			}
		};
	} catch (error) {
		return refusal(
			'no-arena',
			`iteration owner unavailable: ${error instanceof Error ? error.message : String(error)}`
		);
	} finally {
		module?.dispose();
	}
}
