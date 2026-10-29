import render from '../../build/render.wasm';
import { register } from '../../worker.ts';

register({ render: { module: render, pages: 1322 } });

export { BootImage, default } from '../../worker.ts';
