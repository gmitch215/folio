import type { Config, Rung } from './config.ts';
import type { Price } from './plan.ts';
import { requestsOf, rowsOf } from './plan.ts';

export class Abort extends Error {}

// the worst case one call can add, from the plan
export interface Expect {
	rows?: number;
	internal?: number;
	external?: number;
}

export interface Seen {
	writeRows: number;
	schemaRows: number;
	cleanupRows: number;
	requests: number;
	internal: number;
	external: number;
}

const blank = (): Seen => ({
	writeRows: 0,
	schemaRows: 0,
	cleanupRows: 0,
	requests: 0,
	internal: 0,
	external: 0
});

// rows written, client requests and internal calls so far, against the plan and the abort caps
export class Counters {
	seen = blank();
	byRung: Partial<Record<Rung | 0, Seen>> = {};
	retries = 0;
	// what the plan expected of the calls issued so far, to project the total
	private issued = { rows: 0, requests: 0, internal: 0, external: 0 };

	planned: Price;
	caps: Config['caps'];
	log: (line: object) => void;

	constructor(planned: Price, caps: Config['caps'], log: (line: object) => void = () => {}) {
		this.planned = planned;
		this.caps = caps;
		this.log = log;
	}

	get rows() {
		return this.seen.writeRows + this.seen.schemaRows + this.seen.cleanupRows;
	}

	// throws before a call that would pass a cap
	guard(expect: Expect) {
		if (this.seen.requests + 1 > this.caps.requests)
			throw new Abort(`client request cap ${this.caps.requests}`);
		if (this.rows + (expect.rows ?? 0) > this.caps.rows)
			throw new Abort(`row cap ${this.caps.rows}`);
	}

	// a first attempt counts toward the projection; a retry only toward the observed total
	issue(expect: Expect, retry = false) {
		if (retry) return void this.retries++;
		this.issued.requests++;
		this.issued.rows += expect.rows ?? 0;
		this.issued.internal += expect.internal ?? 0;
		this.issued.external += expect.external ?? 0;
	}

	record(rung: Rung | 0, delta: Partial<Seen>) {
		const mine = (this.byRung[rung] ??= blank());
		for (const key of Object.keys(delta) as (keyof Seen)[]) {
			this.seen[key] += delta[key] ?? 0;
			mine[key] += delta[key] ?? 0;
		}
	}

	// what the run will have counted if every call not yet issued does what the plan says
	projected() {
		const left = (planned: number, issued: number) => Math.max(0, planned - issued);
		return {
			rows: this.rows + left(rowsOf(this.planned), this.issued.rows),
			requests: this.seen.requests + left(requestsOf(this.planned), this.issued.requests),
			internal: this.seen.internal + left(this.planned.internal, this.issued.internal),
			external: this.seen.external + left(this.planned.external, this.issued.external)
		};
	}

	progress(label: string) {
		const p = this.projected();
		this.log({
			progress: label,
			rows: this.rows,
			rowsProjected: p.rows,
			rowCap: this.caps.rows,
			requests: this.seen.requests,
			requestsProjected: p.requests,
			requestCap: this.caps.requests,
			internal: this.seen.internal,
			internalProjected: p.internal,
			external: this.seen.external,
			externalProjected: p.external,
			retries: this.retries
		});
	}
}
