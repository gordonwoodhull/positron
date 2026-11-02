/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

import { findInlineExprSpans, spanValueFromMessages, SpanMessage } from '../../browser/quartoInlineExpr.js';

describe('findInlineExprSpans', () => {
	const find = (doc: string, lang = 'python') => findInlineExprSpans(doc.split('\n'), lang);

	it('finds a span with its language, code and range', () => {
		const spans = find('The answer is `{python} 1 + 1`.');
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ language: 'python', code: '1 + 1', line: 1, startColumn: 15, endColumn: 31 });
	});

	it('finds several spans per line and across lines, in document order', () => {
		const spans = find('`{python} a` and `{python} b`\nthen `{python} c`');
		expect(spans.map(s => [s.code, s.line])).toEqual([['a', 1], ['b', 1], ['c', 2]]);
	});

	it('ignores plain code spans, other languages, and spans inside fenced code', () => {
		const doc = ['`x`', '`{r} 1`', '```python', 'print("`{python} 2`")', '```', '`{python} 3`'].join('\n');
		expect(find(doc).map(s => s.code)).toEqual(['3']);
	});

	it('requires a space and an expression after the language', () => {
		expect(find('`{python}` `{python}x`')).toHaveLength(0);
	});

	it('does not open a span at an escaped backtick', () => {
		expect(find('\\`{python} 1\\`')).toHaveLength(0);
		expect(find('\\`{python} 1`')).toHaveLength(0);
	});

	it('opens a span after an escaped backslash (even run of backslashes)', () => {
		const spans = find('\\\\`{python} 1`');
		expect(spans.map(s => s.code)).toEqual(['1']);
		expect(spans[0].startColumn).toBe(3);
	});

	it('still finds a real span next to an escaped one', () => {
		expect(find('\\`{python} 1\\` and `{python} 2`').map(s => s.code)).toEqual(['2']);
	});

	it('does not treat a backslash inside a span as an escape of the closing backtick', () => {
		expect(find('`{python} "a\\"`').map(s => s.code)).toEqual(['"a\\"']);
	});
});

describe('spanValueFromMessages (last output with a text mime)', () => {
	const result = (data: Record<string, string>): SpanMessage => ({ kind: 'result', data });
	const output = (data: Record<string, string>): SpanMessage => ({ kind: 'output', data });

	it('takes text/plain of an execute_result', () => {
		expect(spanValueFromMessages([result({ 'text/plain': '2' })])).toEqual({ ok: true, text: '2' });
	});

	it('takes a display_data-only value (never keyed on output type)', () => {
		expect(spanValueFromMessages([output({ 'text/plain': 'hi' })])).toEqual({ ok: true, text: 'hi' });
	});

	it('uses the last text-carrying output', () => {
		const m = [result({ 'text/plain': '1' }), output({ 'text/plain': '2' }), output({ 'image/png': 'xx' })];
		expect(spanValueFromMessages(m)).toEqual({ ok: true, text: '2' });
	});

	it('prefers text/markdown over text/plain', () => {
		expect(spanValueFromMessages([result({ 'text/plain': '**b**', 'text/markdown': '**b**' })]).text).toBe('**b**');
	});

	it('yields no value for a statement', () => {
		expect(spanValueFromMessages([{ kind: 'stream', text: 'x' }])).toEqual({ ok: true, text: undefined });
	});

	it('reports an error', () => {
		expect(spanValueFromMessages([{ kind: 'error', name: 'NameError', message: 'boom' }]))
			.toEqual({ ok: false, error: 'NameError: boom' });
	});
});
