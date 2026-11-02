/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

// Spike S4 (q2 interop): the span value rule against q2's EXR-3 rule. The two fixture
// files are copies of the ones shared by `presenter/inline.rs` and
// `ts-packages/quarto-api/src/jupyter/` in q2 (see fixtures/README in the spike notes).

import { asEscapedMarkdown, displayDataMimeType, spanValueFromMessages, SpanMessage } from '../../browser/quartoInlineExpr.js';

import precedenceFixture from './fixtures/display-data-precedence.json' with { type: 'json' };
import escapeFixture from './fixtures/inline-escape.json' with { type: 'json' };

describe('displayDataMimeType (shared precedence fixture)', () => {
	const { cases } = precedenceFixture as unknown as {
		cases: { name: string; flags: { toHtml?: boolean; toLatex?: boolean; toMarkdown?: boolean }; data: Record<string, unknown>; expected: string | null }[];
	};
	for (const c of cases) {
		it(c.name, () => {
			expect(displayDataMimeType(c.data, c.flags)).toBe(c.expected);
		});
	}
});

describe('asEscapedMarkdown (shared escape fixture)', () => {
	const cases = escapeFixture as unknown as { input: string; expected: string }[];
	for (const c of cases) {
		it(JSON.stringify(c.input), () => {
			expect(asEscapedMarkdown(c.input)).toBe(c.expected);
		});
	}
});

describe('spanValueFromMessages against the EXR-3 cases', () => {
	const result = (data: Record<string, unknown>): SpanMessage => ({ kind: 'result', data });
	const display = (data: Record<string, unknown>): SpanMessage => ({ kind: 'output', data });
	const html = { toHtml: true };

	it('an integer', () => {
		expect(spanValueFromMessages([result({ 'text/plain': '2' })], html).text).toBe('2');
	});

	it('a string: quotes stripped and markdown characters escaped', () => {
		expect(spanValueFromMessages([result({ 'text/plain': "'hello_world'" })], html).text).toBe('hello\\_world');
	});

	it('markdown is inserted as is', () => {
		const m = result({ 'text/markdown': '**b**', 'text/plain': '<IPython.core.display.Markdown object>' });
		expect(spanValueFromMessages([m], html).text).toBe('**b**');
	});

	it('HTML() to an HTML target is a raw html span, as in Q1', () => {
		const m = display({ 'text/html': '<b>hi</b>', 'text/plain': '<IPython.core.display.HTML object>' });
		expect(spanValueFromMessages([m], html).text).toBe('`<b>hi</b>`{=html}');
	});

	it('HTML() with no HTML target falls back to the text/plain repr', () => {
		const m = display({ 'text/html': '<b>hi</b>', 'text/plain': '<IPython.core.display.HTML object>' });
		expect(spanValueFromMessages([m], {}).text).toBe('<IPython.core.display.HTML object>');
	});

	it('None is the text None', () => {
		expect(spanValueFromMessages([result({ 'text/plain': 'None' })], html).text).toBe('None');
	});

	it('a DataFrame to an HTML target is its html table', () => {
		const m = result({ 'text/html': '<table><tr><td>1</td></tr></table>', 'text/plain': '   a\n0  1' });
		expect(spanValueFromMessages([m], html).text).toBe('`<table><tr><td>1</td></tr></table>`{=html}');
	});

	it('the editor view of a DataFrame is its text/plain repr', () => {
		const m = result({ 'text/html': '<table><tr><td>1</td></tr></table>', 'text/plain': '   a\n0  1' });
		expect(spanValueFromMessages([m], {}, { textOnly: true }).text).toBe('   a\n0  1');
	});

	it('a statement gives no value', () => {
		expect(spanValueFromMessages([{ kind: 'stream', text: 'x' }], html)).toEqual({ ok: true, text: undefined });
	});

	it('an error wins over a value', () => {
		const out = spanValueFromMessages([result({ 'text/plain': '1' }), { kind: 'error', name: 'NameError', message: 'x' }], html);
		expect(out).toEqual({ ok: false, error: 'NameError: x' });
	});

	it('a value that arrives only as display_data still counts', () => {
		expect(spanValueFromMessages([display({ 'text/plain': '7' })], html).text).toBe('7');
	});

	it('an image-only bundle gives no value', () => {
		expect(spanValueFromMessages([result({ 'image/png': 'iVBOR' })], html).text).toBeUndefined();
	});
});
