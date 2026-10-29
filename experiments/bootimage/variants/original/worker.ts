import imp from '../../build/imp.wasm';
import original from '../../build/original.wasm';
import own128 from '../../build/own128.wasm';
import own16 from '../../build/own16.wasm';
import own64 from '../../build/own64.wasm';
import { register } from '../../worker.ts';

register({
	original: { module: original, pages: 1024 },
	imp: { module: imp, pages: 1 },
	own16: { module: own16, pages: 256 },
	own64: { module: own64, pages: 1024 },
	own128: { module: own128, pages: 2048 }
});

export { BootImage, default } from '../../worker.ts';
