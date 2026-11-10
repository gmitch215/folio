import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { enumerateHeader, enumerateProject } from '../../scripts/research/corpus-enumerate.ts';

const header = [
	'#ifndef SAMPLE_H',
	'#define SAMPLE_H',
	'#include <stddef.h>',
	'// int commented_out(int x);',
	'/* size_t also_hidden(void *p); */',
	'#define FUNCTION_LIKE(x) ((x) + 1)',
	'#define OBJECT_LIKE 4',
	'typedef int (*callback_t)(int value);',
	'struct sample { int a; int (*fp)(void); };',
	'extern int table_size;',
	'int sample_init(struct sample *s, int flags);',
	'const char *sample_name(const struct sample *s);',
	'size_t sample_encode(const unsigned char *in, size_t in_len,',
	'                    unsigned char *out, size_t out_cap);',
	'DECLARE_MACRO_FUNCTION(sample_extra);',
	'void (*sample_hook)(void);',
	'static inline int sample_twice(int v) {',
	'\treturn v * 2;',
	'}',
	'#endif'
].join('\n');

const bytes = new TextEncoder().encode(header);

test('functions keep file order, skip comments and typedefs, and report unparsed lines', () => {
	const result = enumerateHeader('sample.h', bytes);
	expect(result.functions.map((f) => f.name)).toEqual([
		'sample_init',
		'sample_name',
		'sample_encode',
		'sample_twice'
	]);
	expect(result.functions.map((f) => f.line)).toEqual([11, 12, 13, 17]);
	expect(result.unparsed).toEqual([
		{ line: 6, text: '#define FUNCTION_LIKE(x) ((x) + 1)' },
		{ line: 15, text: 'DECLARE_MACRO_FUNCTION(sample_extra)' },
		{ line: 16, text: 'void (*sample_hook)(void)' }
	]);
});

test('signature fields are read from the declaration text', () => {
	const [init, name, encode, twice] = enumerateHeader('sample.h', bytes).functions;
	expect(init).toMatchObject({
		returnType: 'int',
		parameters: 'struct sample *s, int flags',
		parameterCount: 2,
		nonConstPointerParams: ['struct sample *s'],
		hasBody: false
	});
	expect(name).toMatchObject({ returnType: 'const char *', nonConstPointerParams: [] });
	expect(encode).toMatchObject({
		returnType: 'size_t',
		signature:
			'size_t sample_encode(const unsigned char *in, size_t in_len, unsigned char *out, size_t out_cap)',
		parameterCount: 4,
		nonConstPointerParams: ['unsigned char *out']
	});
	expect(twice).toMatchObject({
		returnType: 'static inline int',
		hasBody: true,
		internal: true
	});
	expect(init).toMatchObject({ internal: false });
});

test('leading all-caps export macros are removed, and a macro argument can be the return type', () => {
	const text = [
		'CJSON_PUBLIC(cJSON *) cJSON_Parse(const char *value);',
		'STBIDEF unsigned char *stbi_load(const char *filename, int *x);',
		'LIBDEFLATEAPI void libdeflate_free(void *p);',
		'FILE *fopen_like(const char *path, const char *mode);',
		'BOOL bool_like(void);',
		'DECLARE_MACRO_FUNCTION(sample_extra);',
		'#define CJSON_PUBLIC(type) type'
	].join('\n');
	const result = enumerateHeader('macro.h', new TextEncoder().encode(text));
	expect(result.functions.map((f) => [f.line, f.name, f.returnType, f.parameters])).toEqual([
		[1, 'cJSON_Parse', 'cJSON *', 'const char *value'],
		[2, 'stbi_load', 'unsigned char *', 'const char *filename, int *x'],
		[3, 'libdeflate_free', 'void', 'void *p'],
		[4, 'fopen_like', 'FILE *', 'const char *path, const char *mode'],
		[5, 'bool_like', 'BOOL', 'void']
	]);
	expect(result.functions[0]).toMatchObject({
		signature: 'CJSON_PUBLIC(cJSON *) cJSON_Parse(const char *value)',
		parameterCount: 1,
		nonConstPointerParams: []
	});
	expect(result.unparsed).toEqual([
		{ line: 6, text: 'DECLARE_MACRO_FUNCTION(sample_extra)' },
		{ line: 7, text: '#define CJSON_PUBLIC(type) type' }
	]);
});

test('object-like macros that build a declaration are listed as unparsed', () => {
	const text = [
		'#define DECLARE_ALL \\',
		'PCRE2_EXP_DECL int PCRE2_CALL_CONVENTION pcre2_config(uint32_t, void *);',
		'#define SAMPLE_LIMIT 4',
		'#define SAMPLE_NAME "sample"'
	].join('\n');
	const result = enumerateHeader('macro.h', new TextEncoder().encode(text));
	expect(result.functions).toEqual([]);
	expect(result.unparsed).toEqual([
		{
			line: 1,
			text: '#define DECLARE_ALL PCRE2_EXP_DECL int PCRE2_CALL_CONVENTION pcre2_config(uint32_t, void *);'
		}
	]);
});

test('declarations behind a PRIVATE or INTERNAL macro are excluded with a reason', () => {
	const text = [
		'DRWAV_PRIVATE void drwav_private_helper(int *p, size_t size);',
		'DRFLAC_INTERNAL int flac_internal(const char *p);',
		'DRMP3_API int drmp3_public(const char *p, size_t size);'
	].join('\n');
	const result = enumerateHeader('macro.h', new TextEncoder().encode(text));
	expect(result.functions.map((f) => f.name)).toEqual(['drmp3_public']);
	expect(result.excluded).toEqual([
		{
			line: 1,
			text: 'DRWAV_PRIVATE void drwav_private_helper(int *p, size_t size)',
			macro: 'DRWAV_PRIVATE',
			reason: 'non-public-macro'
		},
		{
			line: 2,
			text: 'DRFLAC_INTERNAL int flac_internal(const char *p)',
			macro: 'DRFLAC_INTERNAL',
			reason: 'non-public-macro'
		}
	]);
});

test('hashes are the SHA-256 of the header bytes and of this script', () => {
	const dir = mkdtempSync(join(tmpdir(), 'enumerate-'));
	mkdirSync(join(dir, 'include'));
	writeFileSync(join(dir, 'include', 'sample.h'), bytes);
	const first = enumerateProject(dir, ['include/sample.h']);
	const second = enumerateProject(dir, ['include/sample.h']);
	expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
	expect(first.headers[0]?.sha256).toBe(digest(bytes));
	const script = new URL('../../scripts/research/corpus-enumerate.ts', import.meta.url);
	expect(first.script.sha256).toBe(digest(readFileSync(script)));
});
