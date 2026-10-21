import assets from '../build/extraction-assets.json' with { type: 'json' };
import original, { BrowserGate } from '../worker.ts';

export { BrowserGate };

export default {
	fetch(request: Request, env: Parameters<typeof original.fetch>[1]) {
		const path = new URL(request.url).pathname;
		if (path === '/run') return original.fetch(request, env);
		const entry = (assets as Record<string, { type: string; text?: string; bytes?: number[] }>)[
			path
		];
		if (request.method !== 'GET' || !entry) return new Response('Not found', { status: 404 });
		let text = entry.text;
		if (path === '/extraction.js')
			text += '\nglobalThis.runBrowserProbe = globalThis.runBrowserExtractionProbe;';
		return new Response(text ?? new Uint8Array(entry.bytes!), {
			headers: {
				'content-type': entry.type,
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Resource-Policy': 'same-origin',
				'Cache-Control': 'no-store'
			}
		});
	}
};
