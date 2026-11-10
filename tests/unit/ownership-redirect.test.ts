import assert from 'node:assert/strict';
import { afterAll, describe, test } from 'vitest';
import { entryValues, fit } from '../../scripts/research/iteration-diff.ts';
import {
	assemble,
	BASES,
	driverWat,
	iterModuleOf,
	iterWat,
	layoutRecords,
	OUT,
	RECORDS,
	TABLE
} from '../../scripts/research/ownership-modules.ts';
import { iterationShadowCopies } from '../../src/iteration-layout.ts';
import { iterationArguments, IterationPool } from '../../src/iteration.ts';
import {
	OwnershipRedirectError,
	ownershipRoute,
	redirectOwnership
} from '../../src/ownership-redirect.ts';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';

const PAGE = 65536;
const SHADOW = 6 * PAGE;

const certificate = (bytes: Uint8Array) => {
	const r = certifyOwnership(bytes);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const image = (seed: number) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	return view.slice();
};

const instance = (bytes: Uint8Array, bits: Uint8Array) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	new Uint8Array(memory.buffer).set(bits);
	const made = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory, f: () => {} }
	});
	return { view: new Uint8Array(memory.buffer), exports: made.exports as Record<string, any> };
};

// the serial program: every record in place
function serial(bytes: Uint8Array, seed: number) {
	const { view, exports } = instance(bytes, image(seed));
	let trapped = -1;
	try {
		exports.bulk(TABLE, RECORDS, OUT);
	} catch {
		trapped = 0;
	}
	return { view, trapped };
}

// the redirected module, one record at a time on a private shadow of the windows, then the copy-out
function redirected(bytes: Uint8Array, cert: OwnershipCertificate, seed: number) {
	const { module, plan } = redirectOwnership(bytes, cert);
	const { view, exports } = instance(module, image(seed));
	const real = plan.windows.map((w) => view.slice(w.low, w.end));
	let trapped = -1;
	for (let i = 0; i < RECORDS && trapped < 0; i++) {
		plan.windows.forEach((w, k) => {
			view.set(real[k]!, SHADOW + 4096 * k);
			exports[w.delta].value = SHADOW + 4096 * k - w.low;
		});
		try {
			exports.bulk(TABLE + 16 * i, 1, OUT + 64 * i);
		} catch {
			trapped = i;
		}
	}
	if (trapped < 0)
		for (const [from, end] of plan.copyOut) {
			const k = plan.windows.findIndex((w) => from >= w.low && end <= w.end);
			const at = SHADOW + 4096 * k - plan.windows[k]!.low;
			view.copyWithin(from, from + at, end + at);
		}
	return { view, trapped };
}

const below = (view: Uint8Array) => view.subarray(0, SHADOW);

describe('ownership redirect', () => {
	test('the redirected module equals the serial program on the shadow, bases and seeds', () => {
		for (const name of Object.keys(BASES)) {
			const bytes = iterModuleOf(BASES[name]!);
			const cert = certificate(bytes);
			for (const seed of [1, 2, 3]) {
				const want = serial(bytes, seed);
				const got = redirected(bytes, cert, seed);
				assert.equal(got.trapped, want.trapped, name);
				assert.deepEqual(below(got.view), below(want.view), `${name} seed ${seed}`);
			}
		}
	});

	test('with the delta at 0 the redirected module runs in place', () => {
		const bytes = iterModuleOf(BASES.scratch!);
		const { module } = redirectOwnership(bytes, certificate(bytes));
		const want = serial(bytes, 2);
		const { view, exports } = instance(module, image(2));
		exports.bulk!(TABLE, RECORDS, OUT);
		assert.deepEqual(view, want.view);
	});

	test('the shadow takes the window writes and the real window stays at its baseline', () => {
		const bytes = iterModuleOf(BASES.scratch!);
		const { module, plan } = redirectOwnership(bytes, certificate(bytes));
		const { view, exports } = instance(module, image(1));
		const baseline = view.slice(4096, 4160);
		view.set(baseline, SHADOW);
		exports[plan.windows[0]!.delta].value = SHADOW - 4096;
		exports.bulk!(TABLE, 2, OUT);
		assert.deepEqual(view.slice(4096, 4160), baseline);
		assert.notDeepEqual(view.slice(SHADOW, SHADOW + 64), baseline);
	});

	test('accesses the certificate proves outside the window are not rewritten', () => {
		const bytes = iterModuleOf(BASES.scratch!);
		const cert = certificate(bytes);
		const { stats } = redirectOwnership(bytes, cert);
		const all = Object.values(cert.accesses).reduce((n, s) => n + s.length, 0);
		assert.equal(stats.redirected + stats.bulk + stats.skipped, all);
		assert.ok(stats.skipped > 0 && stats.redirected > 0);
	});

	test('a dynamic access that straddles the window edge traps and the serial path decides', () => {
		const body = `(memory.fill (i32.const 4096) (i32.const 9) (i32.const 64))
			(i32.store (local.get $slot)
				(i32.load (i32.add (i32.const 4094) (i32.and (local.get $sum) (i32.const 3)))))`;
		const bytes = assemble(iterWat({ body }));
		const cert = certificate(bytes);
		assert.ok(Object.values(cert.accesses).some((modes) => modes.includes('d')));
		const { module, plan } = redirectOwnership(bytes, cert);
		const { view, exports } = instance(module, image(1));
		view.set(view.slice(4096, 4160), SHADOW);
		exports[plan.windows[0]!.delta].value = SHADOW - 4096;
		let straddled = 0;
		for (let i = 0; i < RECORDS; i++) {
			const at = new Uint32Array(view.buffer.slice(TABLE + 16 * i, TABLE + 16 * i + 8));
			const sum = view.subarray(at[0]!, at[0]! + at[1]!).reduce((n, b) => n + b, 0);
			try {
				exports.bulk!(TABLE + 16 * i, 1, OUT + 64 * i);
				assert.ok((sum & 3) >= 2);
			} catch {
				straddled++;
				assert.ok((sum & 3) < 2);
			}
		}
		assert.ok(straddled > 0);
	});

	test('a certificate for another module or a stale one is refused with a typed error', () => {
		const bytes = iterModuleOf(BASES.scratch!);
		const cert = certificate(bytes);
		assert.throws(
			() => redirectOwnership(iterModuleOf(BASES.fill!), cert),
			(error) => error instanceof OwnershipRedirectError && error.code === 'unbound'
		);
		assert.throws(
			() => redirectOwnership(bytes, { ...cert, windows: [{ low: 4096, end: 8192 }] }),
			(error) => error instanceof OwnershipRedirectError && error.code === 'stale'
		);
		const flat = assemble(driverWat({ body: BASES.scratch!.join('\n') }));
		assert.equal(ownershipRoute(flat, certificate(flat)).route.eligible, false);
	});

	test('the shadow copies sit below the frame at the offset of their window', () => {
		const windows = [
			{ low: 4096, end: 4160 },
			{ low: 8192, end: 8448 }
		];
		const { copies, low } = iterationShadowCopies(100000, 128, windows);
		windows.forEach((w, i) => {
			assert.equal((copies[i]!.copy - w.low) % 64, 0);
			assert.equal(copies[i]!.delta, copies[i]!.copy - w.low);
		});
		assert.ok(copies[0]!.copy + 64 <= 100000 - 128);
		assert.ok(copies[1]!.copy + 256 <= copies[0]!.copy);
		assert.equal(low, copies[1]!.copy);
	});
});

describe('ownership redirect on the iteration pool', () => {
	const pools: IterationPool[] = [];
	afterAll(() => Promise.all(pools.map((pool) => pool.close())));

	test('every record runs on a worker and the window ends as the serial run leaves it', async () => {
		const bytes = iterModuleOf(BASES.scratch!);
		const { route } = ownershipRoute(bytes, certificate(bytes));
		assert.ok(route.eligible);
		const f = fit(8 * PAGE);
		const memory = new WebAssembly.Memory({ initial: f.pages, maximum: f.pages, shared: true });
		const pool = await IterationPool.open(route, memory, { arenaBase: f.arenaBase, width: 2 });
		pools.push(pool);
		const plain = new WebAssembly.Instance(
			new WebAssembly.Module(Uint8Array.from(route.module!)),
			{ env: { memory } }
		);
		const view = new Uint8Array(memory.buffer);
		view.set(image(2));
		const entry = entryValues(route, [TABLE, RECORDS, OUT]);
		const iterate = plain.exports[route.iterate!] as (...a: number[]) => void;
		pool.run({
			trip: RECORDS,
			frameBase: 0,
			entry,
			replay: (k) => iterate(...(iterationArguments(route.locals, entry, k, 0) as number[]))
		});
		const want = serial(bytes, 2);
		assert.deepEqual(view.slice(0, f.arenaBase), want.view.subarray(0, f.arenaBase));
		assert.equal(pool.report.replayed, 0);
		assert.equal(pool.report.regions, RECORDS);
	});
});
