import type { LogicalHeap } from './elastic-pager.ts';

const VIEW_NAMES: Record<string, string> = {
	Int8Array: 'HEAP8',
	Uint8Array: 'HEAPU8',
	Int16Array: 'HEAP16',
	Uint16Array: 'HEAPU16',
	Int32Array: 'HEAP32',
	Uint32Array: 'HEAPU32',
	Float32Array: 'HEAPF32',
	Float64Array: 'HEAPF64'
};

const VIEWS = 'var cfwSafeSubarray=function(v){';
const TO_STRING =
	'var UTF8ToString=(ptr,maxBytesToRead)=>{ptr>>>=0;return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""};';
const FROM_STRING =
	'var stringToUTF8=(str,outPtr,maxBytesToWrite)=>stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite);';

// the emscripten glue builds its eight heap views in one place and reads strings with two helpers;
// the first anchor swaps the views and the other two keep a string scan off a per-byte proxy
export function patchGlue(source: string): string {
	for (const anchor of [VIEWS, TO_STRING, FROM_STRING])
		if (source.split(anchor).length !== 2)
			throw new Error(`folio.pager: glue anchor not found once: ${anchor.slice(0, 40)}`);
	return source
		.replace(
			VIEWS,
			() =>
				VIEWS +
				'var __h=globalThis.__folioHeapHook&&globalThis.__folioHeapHook(v);if(__h)return __h;'
		)
		.replace(
			TO_STRING,
			() =>
				'var UTF8ToString=(ptr,maxBytesToRead)=>{ptr>>>=0;if(!ptr)return"";var h=globalThis.__folioHeap;' +
				'if(h){var b=h.cstr(ptr,maxBytesToRead);return UTF8ArrayToString(b,0,b.length)}' +
				'return UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead)};'
		)
		.replace(
			FROM_STRING,
			() =>
				'var stringToUTF8=(str,outPtr,maxBytesToWrite)=>{var h=globalThis.__folioHeap;' +
				'if(!h)return stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite);' +
				'outPtr>>>=0;if(!(maxBytesToWrite>0))return 0;' +
				'var t=new Uint8Array(Math.min(maxBytesToWrite,4*str.length+1));' +
				'var n=stringToUTF8Array(str,t,0,t.length);h.write(outPtr,t.subarray(0,n+1));return n};'
		);
}

// the patched glue reads these two globals; clear them to run an unpatched module again
export function installGlueHooks(heap: LogicalHeap | undefined) {
	const g = globalThis as Record<string, unknown>;
	if (!heap) {
		delete g.__folioHeap;
		delete g.__folioHeapHook;
		return;
	}
	g.__folioHeap = heap;
	g.__folioHeapHook = (view: { constructor: { name: string } }) =>
		heap.views[VIEW_NAMES[view.constructor.name]! as keyof LogicalHeap['views']];
}
