import { readFileSync } from 'node:fs';

// wrangler tail --format json writes pretty-printed objects back to back, so split on top-level braces
export function readTail(path) {
	const text = readFileSync(path, 'utf8');
	const events = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
		} else if (c === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				events.push(JSON.parse(text.slice(start, i + 1)));
				start = -1;
			}
		}
	}
	return events;
}
