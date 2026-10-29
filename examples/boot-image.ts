import { bakeModule, captureImage } from '@gmitch215/folio/bake';
import binaryen from 'binaryen';

// Capture the memory a boot function leaves behind and bake it into the module, so a new instance
// starts initialized. The host still owns secrets, random state and handles: renew them after replay.
const wat = binaryen.parseText(`(module
	(memory (export "memory") 1)
	(func (export "boot") (i32.store (i32.const 0) (i32.const 42))))`);
const bytes = wat.emitBinary();
wat.dispose();

const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource));
const memory = instance.exports.memory as WebAssembly.Memory;
const fresh = new Uint8Array(memory.buffer).slice();
(instance.exports.boot as () => void)();

const image = captureImage(memory, fresh);
console.log('changed pages', image.pages);

const baked = await bakeModule(bytes, image);
const started = new WebAssembly.Instance(new WebAssembly.Module(baked as BufferSource));
const word = new Uint32Array((started.exports.memory as WebAssembly.Memory).buffer)[0];
console.log('first word after instantiation', word);

// a module with a start function would run it again over the image, so baking refuses it
