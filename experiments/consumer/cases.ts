import type { Api, Call, Case, Spec } from './measure.ts';

export interface Fresh {
	imports: WebAssembly.Imports;
	memory?: WebAssembly.Memory;
}

export interface Consumer {
	spec: Spec;
	/** Folio widths to open beside the native arm */
	widths: number[];
	fresh(
		module: WebAssembly.Module,
		memories: { initial: number; maximum?: number; shared: boolean }[]
	): Fresh;
}

const mebibyte = 1048576;
const call = (api: Api, name: string, ...args: number[]) =>
	(api.exports[name] as CallableFunction)(...args) as number;

const kernelCount = 67;
const kernelAddress = 65536;
const kernelRounds = 524288;

// the counted-loop fixture behind the browser proof; it shows the backend can win and is not a consumer
const kernel: Consumer = {
	widths: [2, 4, 8],
	fresh() {
		const memory = new WebAssembly.Memory({ initial: 256, maximum: 8192, shared: true });
		return { memory, imports: { env: { memory } } };
	},
	spec: {
		name: 'kernel-control',
		cases: [
			{
				name: 'program-67x524k',
				prepare(api) {
					const words = new Uint32Array(api.memory.buffer);
					for (let index = 0; index < kernelCount; index++)
						words[kernelAddress / 4 + index] = index + 1;
					return [
						{ export: 'program', args: [kernelAddress, kernelCount, kernelRounds] }
					];
				}
			}
		]
	}
};

const gmux: Consumer = {
	widths: [8],
	fresh(module, memories) {
		const descriptor = memories[0]!;
		const maximum = descriptor.maximum ?? 32768;
		const memory = new WebAssembly.Memory({
			initial: Math.max(descriptor.initial, Math.min(1024, maximum)),
			maximum,
			shared: descriptor.shared
		});
		const imports: WebAssembly.Imports = {};
		for (const item of WebAssembly.Module.imports(module)) {
			const namespace = (imports[item.module] ??= {}) as Record<string, unknown>;
			if (item.kind === 'memory') namespace[item.name] = memory;
			else if (item.kind === 'table')
				namespace[item.name] = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
			else if (item.kind === 'global')
				namespace[item.name] = new WebAssembly.Global(
					{
						value: 'i32',
						mutable: item.name === '__stack_pointer' || item.module === 'GOT.mem'
					},
					item.name === '__stack_pointer'
						? 7 * mebibyte
						: item.name === '__memory_base'
							? 4096
							: item.name === 'kb_pending_flag'
								? 2048
								: 0
				);
			else if (item.kind === 'function')
				namespace[item.name] = () => {
					throw new Error(`unprovided effect: ${item.module}.${item.name}`);
				};
		}
		return { imports, memory };
	},
	spec: {
		name: 'gmux-abi',
		cases: [
			{
				name: 'memset-16mib',
				prepare: () => [{ export: 'memset', args: [8 * mebibyte, 0xa5, 16 * mebibyte] }]
			},
			{
				name: 'memcpy-16mib',
				prepare(api) {
					new Uint8Array(api.memory.buffer, 8 * mebibyte, 16 * mebibyte).fill(0x3c);
					return [
						{ export: 'memcpy', args: [28 * mebibyte, 8 * mebibyte, 16 * mebibyte] }
					];
				}
			},
			{
				name: 'memset-memcpy-chain',
				prepare: () => [
					{ export: 'memset', args: [8 * mebibyte, 0x11, 8 * mebibyte] },
					{ export: 'memcpy', args: [20 * mebibyte, 8 * mebibyte, 8 * mebibyte] },
					{ export: 'memset', args: [32 * mebibyte, 0x22, 8 * mebibyte] }
				]
			}
		]
	}
};

const size = 1024;
const images = new WeakMap<Api, number>();
const scratch = new WeakMap<Api, number[]>();

function bytes(api: Api, values: number[]) {
	const pointer = call(api, 'tiny_alloc', values.length);
	new Uint8Array(api.memory.buffer, pointer, values.length).set(values);
	scratch.set(api, [...(scratch.get(api) ?? []), pointer]);
	return pointer;
}

function image(api: Api) {
	call(api, 'tiny_init');
	const pointer = call(api, 'tiny_alloc', call(api, 'tiny_image_sizeof'));
	const pixel = call(api, 'tiny_alloc', 4);
	if (call(api, 'tiny_image_create', pointer, size, size, 4) !== 0) throw new Error('create');
	const colors = [
		[0x31, 0x67, 0xaa, 0xff],
		[0xe0, 0x40, 0x10, 0xff],
		[0x20, 0xc0, 0x80, 0xff],
		[0xf0, 0xf0, 0x30, 0xff]
	];
	colors.forEach((color, index) => {
		new Uint8Array(api.memory.buffer, pixel, 4).set(color);
		const x = (index % 2) * (size / 2) + index * 16;
		const y = Math.floor(index / 2) * (size / 2) + index * 8;
		call(api, 'tiny_image_fill_rectangle', pointer, x, y, size / 2, size / 2, pixel);
	});
	call(api, 'tiny_free', pixel);
	images.set(api, pointer);
	return pointer;
}

const operation = (
	name: string,
	entry: string,
	rest: number[] | ((api: Api) => number[]) = []
): Case => ({
	name,
	prepare(api): Call[] {
		const pointer = image(api);
		return [
			{ export: entry, args: [pointer, ...(typeof rest === 'function' ? rest(api) : rest)] }
		];
	},
	finish(api) {
		for (const pointer of scratch.get(api) ?? []) call(api, 'tiny_free', pointer);
		scratch.delete(api);
		const pointer = images.get(api)!;
		call(api, 'tiny_image_destroy', pointer);
		call(api, 'tiny_free', pointer);
	}
});

const tinyimg: Consumer = {
	widths: [8],
	fresh: () => ({ imports: {} }),
	spec: {
		name: 'tinyimg',
		cases: [
			operation('fill-rectangle', 'tiny_image_fill_rectangle', (api) => [
				0,
				0,
				size,
				size,
				bytes(api, [0x10, 0x80, 0xf0, 0xff])
			]),
			operation('replace-color', 'tiny_image_replace_color', (api) => [
				bytes(api, [0x31, 0x67, 0xaa, 0xff]),
				bytes(api, [0x00, 0xff, 0x00, 0xff]),
				bytes(api, [8, 8, 8, 8])
			]),
			operation('fill-ellipse', 'tiny_image_fill_ellipse', (api) => [
				size / 2,
				size / 2,
				size / 2 - 8,
				size / 2 - 40,
				bytes(api, [0xff, 0x00, 0x80, 0xff])
			]),
			operation('opacity', 'tiny_image_opacity', [0.5]),
			operation('convert-channels', 'tiny_image_convert_channels', [3]),
			operation('crop-circle', 'tiny_image_crop_circle', [size / 2, size / 2, size / 2 - 4]),
			operation('shear', 'tiny_image_shear', (api) => [0.25, 0.1, bytes(api, [0, 0, 0, 0])]),
			operation('invert', 'tiny_image_invert'),
			operation('sepia', 'tiny_image_apply_sepia'),
			operation('saturation', 'tiny_image_saturation', [1.4]),
			operation('gaussian-blur', 'tiny_image_gaussian_blur', [3]),
			operation('sobel', 'tiny_image_sobel'),
			operation('resize-half', 'tiny_image_resize', [size / 2, size / 2])
		]
	}
};

export const consumers: Record<string, Consumer> = {
	'kernel-control': kernel,
	'gmux-abi': gmux,
	tinyimg
};
