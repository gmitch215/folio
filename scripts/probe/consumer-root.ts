import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The Drupal host checkout a probe drives: `explicit`, else FOLIO_CONSUMER. */
export function consumerRoot(explicit?: string): string {
	const root = explicit ?? process.env.FOLIO_CONSUMER;
	if (!root) throw new Error('set FOLIO_CONSUMER to the Drupal host checkout the probe drives');
	return resolve(root);
}

/**
 * Resolves a `consumer:` import. `consumer:host/<role>` names a host file by role; the JSON file
 * in FOLIO_HOST_MODULES maps each role to a path under the checkout. Any other path is joined to
 * the checkout as is.
 */
export function resolveConsumer(root: string, specifier: string): string {
	const path = specifier.slice('consumer:'.length);
	if (!path.startsWith('host/')) return join(root, path);
	const file = process.env.FOLIO_HOST_MODULES;
	if (!file)
		throw new Error('set FOLIO_HOST_MODULES to the JSON file that maps host roles to files');
	const roles: Record<string, string> = JSON.parse(readFileSync(file, 'utf8'));
	const target = roles[path.slice('host/'.length)];
	if (!target) throw new Error(`FOLIO_HOST_MODULES has no role ${path}`);
	return join(root, target);
}
