import boot from '../../build/boot.wasm';
import { register } from '../../worker.ts';

register({ boot: { module: boot, pages: 1024 } });

export { BootImage, default } from '../../worker.ts';
