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
	| { kind: 'result' | 'output'; data: Record<string, unknown> }
	| { kind: 'stream'; text: string }
	| { kind: 'error'; name: string; message: string };

export interface SpanValue {
	ok: boolean;
	text?: string;
	error?: string;
}

/** Output-format flags, as in Quarto 1's `JupyterToMarkdownOptions`. No flag means "other". */
export interface TargetFlags {
	toHtml?: boolean;
	toLatex?: boolean;
	toMarkdown?: boolean;
}

const TEXT_HTML = 'text/html';
const TEXT_LATEX = 'text/latex';
const TEXT_MARKDOWN = 'text/markdown';
const TEXT_PLAIN = 'text/plain';
const TEXT_MIMES = [TEXT_HTML, TEXT_LATEX, TEXT_MARKDOWN, TEXT_PLAIN];

function asLines(v: unknown): string[] | undefined {
	if (Array.isArray(v)) {
		return v.map(String);
	}
	return typeof v === 'string' ? [v] : undefined;
}

function hasHtmlTable(data: Record<string, unknown>): boolean {
	const html = asLines(data[TEXT_HTML])?.map(l => l.toLowerCase());
	return !!html && html.some(l => /<table/.test(l)) && html.some(l => /<\/table/.test(l));
}

/**
 * Port of Quarto 1's `displayDataMimeType` (and of q2's `display_data_mime_type` and
 * `@quarto/api`'s TypeScript port): the best mime type in `data` for the target.
 */
export function displayDataMimeType(data: Record<string, unknown>, flags: TargetFlags): string | null {
	const widgetsAndHtml = [
		'application/vnd.jupyter.widget-state+json',
		'application/vnd.jupyter.widget-view+json',
		'application/javascript',
		TEXT_HTML,
	];
	const priority = [TEXT_MARKDOWN, 'image/svg+xml', 'image/png', 'image/jpeg'];
	if (flags.toHtml) {
		// Q1 unshifts the widget/html cluster to the front whether or not toMarkdown is set.
		priority.unshift(...widgetsAndHtml);
	} else if (flags.toLatex) {
		priority.push(TEXT_LATEX, 'application/pdf');
	} else if (flags.toMarkdown) {
		priority.push(TEXT_HTML);
	}
	// An html table is read directly into the Pandoc AST, so html is a candidate.
	if (hasHtmlTable(data) && !priority.includes(TEXT_HTML)) {
		priority.push(TEXT_HTML);
	}
	priority.push(TEXT_PLAIN);
	return priority.find(m => m in data) ?? null;
}

/**
 * Q1's `asEscapedMarkdown`: only a quoted value (single or double quotes) is changed. The
 * quotes are stripped, backslashes doubled, and markdown characters escaped. The character
 * class keeps Q1's `+-.` range, which also covers the comma.
 */
export function asEscapedMarkdown(s: string): string {
	if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
		s = s.slice(1, -1);
		return s.replace(/\\/g, '\\\\').replace(/([\\`*_{}[\]()>#+-.!])/g, '\\$1');
	}
	return s;
}

/** A raw inline span whose fence is longer than any backtick run in `data`. */
function rawInline(data: string, format: 'html' | 'tex'): string {
	const longest = Math.max(0, ...(data.match(/`+/g) ?? []).map(r => r.length));
	const ticks = '`'.repeat(longest + 1);
	return `${ticks}${data}${ticks}{=${format}}`;
}

/**
 * Present one output's value as markdown, or `undefined` when the bundle has no usable
 * text type. Only text mime types are candidates (an image or widget cannot be spliced
 * into prose). `textOnly` additionally drops html and latex: what an editor decoration,
 * which can show only text, needs.
 */
export function renderInlineValue(data: Record<string, unknown>, flags: TargetFlags, textOnly = false): string | undefined {
	const allowed = textOnly ? [TEXT_MARKDOWN, TEXT_PLAIN] : TEXT_MIMES;
	const candidates = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
	const mime = displayDataMimeType(candidates, flags);
	if (!mime) {
		return undefined;
	}
	const text = asLines(candidates[mime])!.join('');
	switch (mime) {
		case TEXT_HTML: return rawInline(text, 'html');
		case TEXT_LATEX: return rawInline(text, 'tex');
		case TEXT_MARKDOWN: return text;
		default: return asEscapedMarkdown(text);
	}
}

/**
 * The span value rule (EXR-3): the last output carrying a text mime type, never keyed on
 * the output type (so a value delivered only as display_data still counts); the mime type
 * is then chosen per target as Quarto 1 does. An error message wins over any value.
 */
export function spanValueFromMessages(messages: readonly SpanMessage[], flags: TargetFlags = {}, options: { textOnly?: boolean } = {}): SpanValue {
	for (const m of messages) {
		if (m.kind === 'error') {
			return { ok: false, error: `${m.name}: ${m.message}` };
		}
	}
	let last: Record<string, unknown> | undefined;
	for (const m of messages) {
		if ((m.kind === 'result' || m.kind === 'output') && TEXT_MIMES.some(t => t in m.data)) {
			last = m.data;
		}
	}
	return { ok: true, text: last && renderInlineValue(last, flags, options.textOnly) };
}
