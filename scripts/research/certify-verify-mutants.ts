import type { StreamCertificate } from '../../src/certify.ts';

export interface Mutant {
	id: string;
	field: string;
	// changes: claims what the module does not do or pins another value; same: claims no more
	claim: 'changes' | 'same';
	why: string;
	cert: StreamCertificate;
}

const clone = (c: StreamCertificate): StreamCertificate => structuredClone(c);
const flipHex = (h: string) => (h[0] === '0' ? '1' : '0') + h.slice(1);

export function mutants(cert: StreamCertificate): Mutant[] {
	const out: Mutant[] = [];
	const add = (
		id: string,
		field: string,
		claim: Mutant['claim'],
		why: string,
		edit: (c: StreamCertificate) => void
	) => {
		const c = clone(cert);
		edit(c);
		out.push({ id, field, claim, why, cert: c });
	};

	for (const ring of ['gf2', 'z2w', 'zp'] as const)
		if (ring !== cert.ring) {
			add(`ring-${ring}`, 'ring', 'changes', 'a different ring is a different model', (c) => {
				c.ring = ring;
				c.model.ring = ring;
			});
			add(
				`ring-only-${ring}`,
				'ring',
				'changes',
				'the proof ring and the model ring disagree',
				(c) => {
					c.ring = ring;
				}
			);
		}
	add('bits', 'bits', 'changes', 'a different state width', (c) => {
		c.bits = cert.bits === 32 ? 64 : 32;
		c.model.bits = c.bits;
		c.layout.bits = c.bits;
		c.model.layout.bits = c.bits;
	});
	add('align', 'model.align', 'changes', 'chunks would need another alignment', (c) => {
		c.model.align = 2;
	});

	const op = cert.model.operator;
	if (Array.isArray(op)) {
		const at = [...new Set([0, 1, Math.floor(op.length / 2), op.length - 1])];
		for (const i of at)
			for (const k of cert.ring === 'gf2' ? [0, 5] : [0]) {
				add(
					`operator-${i}-${k}`,
					'model.operator',
					'changes',
					'one matrix entry differs',
					(c) => {
						const m = c.model.operator as bigint[];
						m[i] = cert.ring === 'gf2' ? m[i]! ^ (1n << BigInt(k)) : m[i]! + 1n;
					}
				);
			}
		if (cert.ring === 'zp') {
			add(
				'operator-plus-p',
				'model.operator',
				'same',
				'an entry plus the modulus is the same residue',
				(c) => {
					const m = c.model.operator as bigint[];
					m[0] = m[0]! + cert.model.modulus!;
				}
			);
			add('modulus', 'model.modulus', 'changes', 'another modulus', (c) => {
				c.model.modulus = cert.model.modulus! + 1n;
			});
		}
	} else {
		add('operator-plus1', 'model.operator', 'changes', 'the multiplier differs', (c) => {
			c.model.operator = (op as bigint) + 1n;
		});
		add('operator-xor', 'model.operator', 'changes', 'the multiplier differs', (c) => {
			c.model.operator = (op as bigint) ^ 2n;
		});
	}

	if (cert.image.length) {
		add('image-digest', 'image', 'changes', 'pins a different table', (c) => {
			c.image[0]!.sha256 = flipHex(c.image[0]!.sha256);
		});
		add('image-drop', 'image', 'changes', 'a read range is no longer pinned', (c) => {
			c.image.pop();
		});
		if (cert.image[0]!.length > 1)
			add('image-shorter', 'image', 'changes', 'the last byte is no longer pinned', (c) => {
				c.image[0]!.length -= 1;
			});
		add('image-address', 'image', 'changes', 'pins other bytes', (c) => {
			c.image[0]!.address += 1;
		});
	}
	if (cert.initialization.length) {
		add('init-byte', 'initialization', 'changes', 'the prefill holds another byte', (c) => {
			c.initialization[0]!.hex = flipHex(c.initialization[0]!.hex);
		});
		add('init-drop', 'initialization', 'changes', 'the table is not prefilled', (c) => {
			c.initialization.pop();
		});
		add('init-address', 'initialization', 'changes', 'the prefill lands elsewhere', (c) => {
			c.initialization[0]!.address += 1;
		});
	}
	if (cert.exclusions.length) {
		add(
			'excl-drop',
			'exclusions',
			'changes',
			'an input may overlap what the call touches',
			(c) => {
				c.exclusions.pop();
			}
		);
		add(
			'excl-shorter',
			'exclusions',
			'changes',
			'the last touched byte is allowed in the input',
			(c) => {
				const e = c.exclusions[0]!;
				e[1] -= 1;
				if (e[1] <= e[0]) c.exclusions.shift();
			}
		);
		add(
			'excl-later',
			'exclusions',
			'changes',
			'the first touched byte is allowed in the input',
			(c) => {
				const e = c.exclusions[0]!;
				e[0] += 1;
				if (e[1] <= e[0]) c.exclusions.shift();
			}
		);
		add('excl-wider', 'exclusions', 'same', 'forbidding more inputs claims less', (c) => {
			c.exclusions[0]![1] += 1;
		});
	}
	add('excl-extra', 'exclusions', 'same', 'forbidding an unrelated range claims less', (c) => {
		c.exclusions.push([
			cert.exclusions.length ? cert.exclusions[cert.exclusions.length - 1]![1] + 100 : 100,
			200 + (cert.exclusions.length ? cert.exclusions[cert.exclusions.length - 1]![1] : 0)
		]);
	});

	if (cert.output) {
		add(
			'output-drop',
			'output',
			'changes',
			'the call rewrites its input but the certificate says it does not',
			(c) => {
				delete c.output;
			}
		);
		add('output-flag', 'output', 'changes', 'not marked in place', (c) => {
			(c.output as unknown as { inPlace: boolean }).inPlace = false;
		});
		if (cert.output.step !== undefined) {
			add('step-plus1', 'output.step', 'changes', 'chunks start from another state', (c) => {
				c.output!.step = cert.output!.step! + 1n;
			});
			add(
				'step-drop',
				'output.step',
				'same',
				'no step only forbids independent chunk starts',
				(c) => {
					delete c.output!.step;
				}
			);
		} else {
			add(
				'step-add',
				'output.step',
				'changes',
				'a step for a state that reads the bytes',
				(c) => {
					c.output!.step = 0n;
				}
			);
		}
	} else {
		add('output-add', 'output', 'changes', 'the call does not rewrite its input', (c) => {
			c.output = { inPlace: true };
		});
	}

	add('module-digest', 'moduleSha256', 'changes', 'describes another module', (c) => {
		c.moduleSha256 = flipHex(c.moduleSha256);
	});
	add('entry-name', 'entry', 'changes', 'names another export', (c) => {
		c.entry = c.entry + 'x';
		c.layout.entry = c.entry;
		c.model.layout.entry = c.entry;
	});
	add('entry-only', 'entry', 'changes', 'the layout names another function', (c) => {
		c.entry = c.entry + 'x';
	});
	add('layout-swap', 'layout', 'changes', 'pointer and length are swapped', (c) => {
		const { ptr, len } = cert.layout;
		c.layout.ptr = len;
		c.layout.len = ptr;
		c.model.layout.ptr = len;
		c.model.layout.len = ptr;
	});
	add('layout-state', 'layout', 'changes', 'the state is the length', (c) => {
		const { state, len } = cert.layout;
		c.layout.state = len;
		c.layout.len = state;
		c.model.layout.state = len;
		c.model.layout.len = state;
	});
	add('schema', 'schema', 'changes', 'another schema', (c) => {
		(c as unknown as { schema: string }).schema = 'folio.certificate.v2';
	});
	if (cert.zeroLength === 'transforms')
		add(
			'zero-identity',
			'zeroLength',
			'changes',
			'claims the identity for a transforming call',
			(c) => {
				c.zeroLength = 'identity';
			}
		);
	else
		add(
			'zero-transforms',
			'zeroLength',
			'same',
			'claims less about a zero length call',
			(c) => {
				c.zeroLength = 'transforms';
			}
		);
	add('block', 'block', 'same', 'the block size is a checker parameter', (c) => {
		c.block = cert.block === 4 ? 16 : 4;
	});
	add('checker', 'checker', 'same', 'a version label', (c) => {
		c.checker = c.checker + '-x';
	});
	add('stats', 'stats', 'same', 'work counters', (c) => {
		c.stats = { paths: 0, loops: 0, expressions: 0 };
	});
	return out;
}
