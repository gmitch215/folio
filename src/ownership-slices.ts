import { redirectOwnership, type OwnershipRedirect } from './ownership-redirect.ts';
import { checkConfig, guardRecords, type OwnershipCertificate } from './ownership.ts';
import {
	SlicePool,
	type SlicePoolOptions,
	type SliceReport,
	type SliceRunOptions
} from './slices.ts';

/**
 * `layout`: a record region overlaps a certified window, so the certificate does not apply.
 * `wild-store`: the module stores to an address outside every window that no record owns, and
 * nothing here tracks it.
 * `config`: the memory or a table word differs from the config the certificate was made for.
 */
export class OwnershipSlicesError extends Error {
	readonly code: 'layout' | 'wild-store' | 'config';

	constructor(code: 'layout' | 'wild-store' | 'config', detail: string) {
		super(detail);
		this.name = 'OwnershipSlicesError';
		this.code = code;
	}
}

export interface OwnershipSliceRunOptions extends Omit<SliceRunOptions, 'writes'> {
	/** Every region the records touch: the table, inputs, aux data, outputs and arena slices. */
	regions: [number, number][];
	/**
	 * The regions the records write outside the windows. They are restored when a slice traps. The
	 * list must name every range the records write: a range left out keeps the writes of the records
	 * after the trap, and the serial replay does not undo them.
	 */
	writes: [number, number][];
}

/**
 * The slice pool over a certified module whose windows are redirected to private copies. A trap in
 * any slice puts `writes` back and runs the calls serially in place, so the serial run decides the
 * memory and the trap.
 * @since 1.1.0
 */
export class OwnershipSlices {
	readonly #pool: SlicePool;
	readonly #certificate: OwnershipCertificate;
	readonly redirect: OwnershipRedirect;

	private constructor(
		pool: SlicePool,
		certificate: OwnershipCertificate,
		redirect: OwnershipRedirect
	) {
		this.#pool = pool;
		this.#certificate = certificate;
		this.redirect = redirect;
	}

	/** Redirects the module and opens the pool. Throws `OwnershipRedirectError` on a stale certificate. */
	static async open(
		bytes: Uint8Array,
		certificate: OwnershipCertificate,
		options: Omit<SlicePoolOptions, 'ownership'>
	): Promise<OwnershipSlices> {
		if (certificate.wildStores)
			throw new OwnershipSlicesError(
				'wild-store',
				`${certificate.wildStores} store sites write an address no record owns`
			);
		const redirect = redirectOwnership(bytes, certificate);
		const pool = await SlicePool.open(redirect.module, {
			...options,
			ownership: redirect.plan
		});
		return new OwnershipSlices(pool, certificate, redirect);
	}

	get memory(): WebAssembly.Memory {
		return this.#pool.memory;
	}

	get size(): number {
		return this.#pool.size;
	}

	/** First byte of the private regions; the memory below it is the program's. */
	get privateBase(): number | undefined {
		return this.#pool.privateBase;
	}

	/** Calls the certified entry for `[0, count)`. Refuses with `OwnershipSlicesError` on a layout overlap. */
	async run(
		count: number,
		args: (from: number, to: number) => (number | bigint)[],
		options: OwnershipSliceRunOptions
	): Promise<SliceReport> {
		const { regions, ...rest } = options;
		if (!guardRecords(this.#certificate, [...regions, ...options.writes]))
			throw new OwnershipSlicesError('layout', 'a record region overlaps a certified window');
		const table = args(0, count)[0];
		if (
			this.#certificate.config &&
			!checkConfig(this.#certificate, new Uint8Array(this.memory.buffer), {
				at: Number(table),
				count
			})
		)
			throw new OwnershipSlicesError(
				'config',
				'the config words differ from the certificate'
			);
		return this.#pool.run(this.#certificate.entry, count, args, rest);
	}

	close(): Promise<void> {
		return this.#pool.close();
	}
}

export const ownershipSlices = OwnershipSlices.open;
