import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// checks touched-raw.json against predictions.json and the capacity-local rows, then writes summary.json

const PAGE = 65536;
const study = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/migration-controls'
);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const predictions = read(join(study, 'predictions.json'));
const touched = read(join(study, 'touched-raw.json'));
const reference = read(resolve(study, '../capacity-local/raw.json'));

for (const source of touched.sources) {
	const bytes = readFileSync(join(study, 'source', source.path));
	assert.equal(bytes.length, source.bytes);
	assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
}
assert.equal(touched.rows.length, 15);
assert.ok(touched.rows.every((r) => r.exact && r.value === r.expected));
for (const row of touched.rows) assert.equal(row.segments.length, 2);
for (const row of touched.rows.filter((r) => r.mode.startsWith('elastic'))) {
	assert.ok(row.segments.every((s) => s.stats.wasmBytes === 327680));
}

const numbers = (text) =>
	String(text)
		.split(', ')
		.map((item) => Number(item.replace(/,/g, '')));

// a prediction entry lists several touch counts as an array, and text values in the order of that array
const expand = (entry) => {
	const touches = Array.isArray(entry.receiverTouched)
		? entry.receiverTouched
		: [entry.receiverTouched];
	return touches.map((t, index) => {
		const fetched = typeof entry.fetchedPages === 'string' ? 4 + t : entry.fetchedPages;
		const totalPages =
			typeof entry.totalPages === 'string'
				? numbers(entry.totalPages)[index]
				: entry.totalPages;
		const totalBytes =
			typeof entry.totalBytes === 'string'
				? numbers(entry.totalBytes)[index]
				: entry.totalBytes;
		return {
			mode: entry.mode,
			receiverTouched: t,
			fetchedPages: fetched,
			checkpointPages: entry.checkpointPages,
			totalPages,
			totalBytes
		};
	});
};

const pick = (mode, receiver) =>
	touched.rows.find(
		(r) => r.mode === mode && r.receiver === receiver && r.mib === 512 && r.working === 4
	);

const rows = predictions.rows.flatMap(expand).map((expected) => {
	const row = pick(expected.mode, expected.receiverTouched);
	assert.ok(row, `missing ${expected.mode} at ${expected.receiverTouched}`);
	const [source, receiverSegment] = row.segments;
	const measured = {
		fetchedPages: row.fetchBytes / PAGE,
		checkpointPages: row.checkpointBytes / PAGE,
		totalPages: row.totalPayloadBytes / PAGE,
		totalBytes: row.totalPayloadBytes
	};
	return {
		mode: row.mode,
		receiverTouched: row.receiver,
		predicted: expected,
		measured,
		match:
			measured.fetchedPages === expected.fetchedPages &&
			measured.checkpointPages === expected.checkpointPages &&
			measured.totalPages === expected.totalPages &&
			measured.totalBytes === expected.totalBytes,
		direction: {
			sourceFetchBytes: source.stats.fetchBytes,
			sourceWritebackBytes: source.stats.writebackBytes,
			checkpointBytes: row.checkpointBytes,
			receiverFetchBytes: receiverSegment.stats.fetchBytes,
			receiverWritebackBytes: receiverSegment.stats.writebackBytes,
			toReceiverBytes: row.checkpointBytes + receiverSegment.stats.fetchBytes,
			fromReceiverBytes: receiverSegment.stats.writebackBytes
		},
		faults: row.segments.reduce((sum, s) => sum + s.stats.faults, 0)
	};
});

const sameAsCapacityLocal = ['eager', 'postcopy', 'prefetch', 'elastic'].map((mode) => {
	const measured = pick(mode, 4);
	const original = reference.rows.find(
		(r) => r.mode === mode && r.mib === 512 && r.working === 4
	);
	assert.ok(original, `capacity-local lacks ${mode} at 512 MiB`);
	const fields = [
		'checkpointBytes',
		'fetchBytes',
		'writebackBytes',
		'totalPayloadBytes',
		'value'
	];
	return {
		mode,
		fields,
		match: fields.every((f) => measured[f] === original[f]),
		touchedRaw: Object.fromEntries(fields.map((f) => [f, measured[f]])),
		captureRaw: Object.fromEntries(fields.map((f) => [f, original[f]]))
	};
});

const mismatches = rows
	.filter((r) => !r.match)
	.map((r) => ({ mode: r.mode, receiverTouched: r.receiverTouched }));
const summary = {
	schema: 'folio.controls-summary.v1',
	setup: '512 MiB logical heap, four pages touched before handoff, receiver touches 1, 2 or 4 of them',
	allExact: touched.rows.every((r) => r.exact),
	rowCount: touched.rows.length,
	predictionMismatches: mismatches,
	referenceMatchesCapacityLocal: sameAsCapacityLocal.every((r) => r.match),
	rows,
	referenceComparison: sameAsCapacityLocal
};
writeFileSync(join(study, 'summary.json'), JSON.stringify(summary, null, '\t') + '\n');
console.log(
	JSON.stringify(
		{
			allExact: summary.allExact,
			predictionMismatches: mismatches,
			referenceMatchesCapacityLocal: summary.referenceMatchesCapacityLocal,
			table: rows.map((r) => [
				r.mode,
				r.receiverTouched,
				r.measured.fetchedPages,
				r.measured.checkpointPages,
				r.measured.totalPages,
				r.match
			])
		},
		null,
		1
	)
);
