export interface RekeyParts {
	salt: boolean;
	key: boolean;
	rng: boolean;
	memory: boolean;
}

/** a PHP single-quoted string literal for any text */
export const phpString = (value: string) =>
	`'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * What a baked Drupal heap holds that belongs to the site that was baked, and the PHP that makes it
 * the replaying site's. Four parts, kept apart so a run can leave one out and show it is needed.
 * Global class names (`Drupal`) need no `use` in a script; one has no effect and PHP warns.
 *
 * Settings is a static singleton whose `storage` is private, and the container's `settings` service
 * is that same object, so the salt is changed in place rather than by a new instance.
 */
export const REKEY_SALT_PHP = `
use Drupal\\Core\\Site\\Settings;
(function (string $salt) {
	$this->storage['hash_salt'] = $salt;
})->call(Settings::getInstance(), __SALT__);
`;

/**
 * State is a cache collector: it serves `system.private_key` from `storage` once loaded. `reset()`
 * empties the in-memory copy so the next read goes to the replaying site's database; `clear()`
 * (what `resetCache()` calls) would also delete the site's cached `state` entry. A key the bake
 * itself created is also kept in `keysSetDuringRequest`.
 */
export const REKEY_KEY_PHP = `
(function () {
	$this->reset();
	$this->keysSetDuringRequest = [];
})->call(Drupal::state());
`;

/** the userland Mersenne Twister state is in the heap; a fresh seed per replay */
export const REKEY_RNG_PHP = `
mt_srand(unpack('V', random_bytes(4))[1]);
`;

/**
 * Values the bake computed from its key and salt and parked in the memory cache bin, such as the
 * permissions hash of the anonymous user, would be served to the new site as if it had made them.
 */
export const REKEY_MEMORY_PHP = `
Drupal::service('cache.memory')->deleteAll();
`;

/** the parts a run applies, by name; `full` is the step to run after every replay */
export const variants: Record<string, RekeyParts> = {
	none: { salt: false, key: false, rng: false, memory: false },
	salt: { salt: true, key: false, rng: false, memory: false },
	key: { salt: false, key: true, rng: false, memory: false },
	'salt+key': { salt: true, key: true, rng: false, memory: false },
	full: { salt: true, key: true, rng: true, memory: true }
};

/** the PHP body (after `<?php`) that applies the chosen parts for a site with this hash salt */
export const rekeyCode = (salt: string, parts: RekeyParts) =>
	[
		parts.salt && REKEY_SALT_PHP.replace('__SALT__', () => phpString(salt)),
		parts.key && REKEY_KEY_PHP,
		parts.memory && REKEY_MEMORY_PHP,
		parts.rng && REKEY_RNG_PHP
	]
		.filter(Boolean)
		.join('');
