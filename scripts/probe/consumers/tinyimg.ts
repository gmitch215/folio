import { readFileSync } from 'node:fs';
import type { Api, Call, Case, Consumer } from '../consumer.ts';

const path = process.env.FOLIO_TINYIMG;
if (!path) throw new Error('set FOLIO_TINYIMG to the tinyimg module');
const size = 1024;
const call = (api: Api, name: string, ...args: number[]) =>
	(api.exports[name] as CallableFunction)(...args) as number;
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
	export_: string,
	rest: number[] | ((api: Api) => number[]) = []
): Case => ({
	name,
	prepare(api): Call[] {
		const pointer = image(api);
		return [
			{ export: export_, args: [pointer, ...(typeof rest === 'function' ? rest(api) : rest)] }
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

const consumer: Consumer = {
	name: 'tinyimg',
	bytes: readFileSync(path),
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
};
export default consumer;
