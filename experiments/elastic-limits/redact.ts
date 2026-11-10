const hosts = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi;

const known: string[] = [];

// remember a value (account id, token, subdomain) so it never reaches a file or a log line
export function remember(value: string | undefined) {
	if (value && value.length >= 4 && !known.includes(value)) known.push(value);
}

export function redact(text: string): string {
	let out = text.replace(hosts, '<workers.dev>');
	for (const value of known) out = out.split(value).join('<redacted>');
	return out;
}

export const scrub = <T>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T;
