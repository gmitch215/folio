import { readFileSync } from 'node:fs';

// one line per counters file: arm, mode, stop, regions, replays, conflicts, undo entries
for (const file of process.argv.slice(2)) {
	const rows = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	const env = rows[0];
	for (const r of rows.filter((x) => x.kind === 'sample' && x.arm !== 'native')) {
		const p = r.report ?? {};
		const c = p.conflicts ?? {};
		console.log(
			[
				env.configuration.id.padEnd(24),
				r.arm.padEnd(10),
				'r' + r.round,
				'mode=' + p.mode,
				'reason=' + (p.reason ?? '-'),
				'stop=' + (p.stopped ?? '-'),
				'regions=' + p.regions,
				'serial=' + p.serial,
				'replayed=' + p.replayed,
				'exh=' + p.exhausted,
				'raw/war/waw/frame=' + [c.raw, c.war, c.waw, c.frame].join('/'),
				'undo/iter=' + (p.undoPerIteration?.toFixed?.(0) ?? '-'),
				'maxLog=' + p.maxLogEntries,
				'wall=' + r.wallMs.toFixed(2),
				'ok=' + r.passed
			].join(' ')
		);
	}
}
