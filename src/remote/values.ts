export type NumberBits = bigint | (bigint | undefined)[];

// Structured clone canonicalizes NaNs. Keep the original numeric ABI bits in
// side metadata so a caller can reinterpret a returned Number without losing them.
function bits(value: unknown): bigint | undefined {
	if (typeof value !== 'number' || !Number.isNaN(value)) return;
	const bytes = new DataView(new ArrayBuffer(8));
	bytes.setFloat64(0, value, true);
	return bytes.getBigUint64(0, true);
}
export function numberBits(value: unknown): NumberBits | undefined {
	if (!Array.isArray(value)) return bits(value);
	const values = value.map(bits);
	return values.some((value) => value !== undefined) ? values : undefined;
}
export function restoreNumbers(value: unknown, encoded: NumberBits): unknown {
	const number = (encoded: bigint) => {
		const bytes = new DataView(new ArrayBuffer(8));
		bytes.setBigUint64(0, encoded, true);
		return bytes.getFloat64(0, true);
	};
	return typeof encoded === 'bigint'
		? number(encoded)
		: (value as unknown[]).map((value, index) =>
				encoded[index] === undefined ? value : number(encoded[index]!)
			);
}
