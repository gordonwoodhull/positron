/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Spike S3/S4 (q2 interop): detection and value rule for inline expressions
// such as `{python} 1 + 1`. Pure functions; no workbench dependencies.

export interface InlineExprSpan {
	readonly language: string;
	readonly code: string;
	/** 1-based line number. */
	readonly line: number;
	/** 1-based start column of the opening backtick. */
	readonly startColumn: number;
	/** 1-based column just after the closing backtick. */
	readonly endColumn: number;
}

const SPAN_RE = /`\{([A-Za-z][\w.+-]*)\}[ \t]+([^`\n]+?)`/g;

/** True if the character at `index` is preceded by an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
	let n = 0;
	while (index - n - 1 >= 0 && text[index - n - 1] === '\\') {
		n++;
	}
	return n % 2 === 1;
}

/**
 * Find inline expression spans, skipping fenced code blocks.
 * Only spans in `language` are returned (the document's primary kernel language).
 */
export function findInlineExprSpans(lines: readonly string[], language: string): InlineExprSpan[] {
	const out: InlineExprSpan[] = [];
	let fence: string | undefined;
	lines.forEach((text, i) => {
		const f = /^\s*(`{3,}|~{3,})/.exec(text);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
				fence = undefined;
			}
			return;
		}
		if (f) {
			fence = f[1];
			return;
		}
		for (const m of text.matchAll(SPAN_RE)) {
			if (m[1].toLowerCase() !== language.toLowerCase()) {
				continue;
			}
			// A backslash-escaped opening backtick is a literal character, not a span
			// opener. Only the opener is checked: inside a code span a backslash is
			// literal and does not escape the closing backtick.
			if (isEscaped(text, m.index)) {
				continue;
			}
			out.push({
				language: m[1],
				code: m[2].trim(),
				line: i + 1,
				startColumn: m.index + 1,
				endColumn: m.index + m[0].length + 1,
			});
		}
	});
	return out;
}

export type SpanMessage =
	| { kind: 'result' | 'output'; data: Record<string, string> }
	| { kind: 'stream'; text: string }
	| { kind: 'error'; name: string; message: string };

export interface SpanValue {
	ok: boolean;
	text?: string;
	error?: string;
}

const TEXT_MIMES = ['text/markdown', 'text/plain'];

/**
 * The span value rule: the last output carrying a text mime type, never keyed
 * on the output type (so a value delivered only as display_data still counts).
 * An error message wins over any value.
 */
export function spanValueFromMessages(messages: readonly SpanMessage[]): SpanValue {
	for (const m of messages) {
		if (m.kind === 'error') {
			return { ok: false, error: `${m.name}: ${m.message}` };
		}
	}
	let text: string | undefined;
	for (const m of messages) {
		if (m.kind === 'result' || m.kind === 'output') {
			const mime = TEXT_MIMES.find(t => typeof m.data[t] === 'string');
			if (mime) {
				text = m.data[mime];
			}
		}
	}
	return { ok: true, text };
}
