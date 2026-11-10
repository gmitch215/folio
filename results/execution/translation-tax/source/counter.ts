// per-page access counters for the request phase; same recorder surface as census/recorder.ts
export function createRecorder() {
	let phaseName = '';
	let off = false;
	let memory: WebAssembly.Memory | undefined;
	const phases: Record<string, { r64: Float64Array; w64: Float64Array; r4: Float64Array; w4: Float64Array }> = {};
	let cur: (typeof phases)[string] | undefined;

	function access(addr: number, bytes: number, w: number) {
		const c = cur!;
		const p64 = addr >>> 16;
		const p4 = addr >>> 12;
		if (w) {
			c.w64[p64]++;
			c.w4[p4]++;
		} else {
			c.r64[p64]++;
			c.r4[p4]++;
		}
		const tail = (addr + bytes - 1) >>> 0;
		if (tail >>> 12 !== p4) {
			const t4 = tail >>> 12;
			if (w) c.w4[t4]++;
			else c.r4[t4]++;
			if (tail >>> 16 !== p64) {
				if (w) c.w64[tail >>> 16]++;
				else c.r64[tail >>> 16]++;
			}
		}
	}

	const env = {
		load_ptr(_id: number, bytes: number, offset: number, ptr: number) {
			if (!off) access((ptr + offset) >>> 0, bytes, 0);
			return ptr;
		},
		store_ptr(_id: number, bytes: number, offset: number, ptr: number) {
			if (!off) access((ptr + offset) >>> 0, bytes, 1);
			return ptr;
		},
		load_val_i32: (_id: number, v: number) => v,
		load_val_i64: (_id: number, v: bigint) => v,
		load_val_f32: (_id: number, v: number) => v,
		load_val_f64: (_id: number, v: number) => v,
		store_val_i32: (_id: number, v: number) => v,
		store_val_i64: (_id: number, v: bigint) => v,
		store_val_f32: (_id: number, v: number) => v,
		store_val_f64: (_id: number, v: number) => v,
		memory_grow_pre: (_a: number, b: number) => b,
		memory_grow_post: (_a: number, b: number) => b
	};

	return {
		env,
		phase(name: string) {
			phaseName = name;
			cur = phases[name] = {
				r64: new Float64Array(1 << 16),
				w64: new Float64Array(1 << 16),
				r4: new Float64Array(1 << 20),
				w4: new Float64Array(1 << 20)
			};
		},
		setOff(value: boolean) {
			off = value;
		},
		attach(m: WebAssembly.Memory) {
			memory = m;
		},
		name: () => phaseName,
		mem: () => memory,
		finish() {
			const out: any[] = [];
			for (const [name, c] of Object.entries(phases)) {
				const pages: Record<string, [number, number]> = {};
				for (let p = 0; p < c.r64.length; p++)
					if (c.r64[p]! + c.w64[p]! > 0) pages[p] = [c.r64[p]!, c.w64[p]!];
				const pages4: Record<string, [number, number]> = {};
				for (let p = 0; p < c.r4.length; p++)
					if (c.r4[p]! + c.w4[p]! > 0) pages4[p] = [c.r4[p]!, c.w4[p]!];
				out.push({ name, touched64: Object.keys(pages).map(Number), pages, pages4 });
			}
			return out;
		}
	};
}
