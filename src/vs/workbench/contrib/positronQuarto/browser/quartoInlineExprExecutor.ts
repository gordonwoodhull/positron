/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Spike S3 (q2 interop): run inline expressions on a document's kernel through
// session.execute, collecting every message so that the console echo, history
// and ordering behavior of each execution mode can be measured.

import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { RuntimeCodeExecutionMode, RuntimeErrorBehavior, RuntimeOnlineState } from '../../../services/languageRuntime/common/languageRuntimeService.js';
import { InlineExprSpan, SpanMessage, SpanValue, spanValueFromMessages } from './quartoInlineExpr.js';

type Msg = { parent_id: string };

/** The slice of ILanguageRuntimeSession the executor uses. */
export interface InlineExprSession {
	execute(code: string, id: string, mode: RuntimeCodeExecutionMode, errorBehavior: RuntimeErrorBehavior): Promise<void>;
	readonly onDidReceiveRuntimeMessageOutput: Event<Msg & { data: Record<string, unknown> }>;
	readonly onDidReceiveRuntimeMessageResult: Event<Msg & { data: Record<string, unknown> }>;
	readonly onDidReceiveRuntimeMessageStream: Event<Msg & { text: string }>;
	readonly onDidReceiveRuntimeMessageError: Event<Msg & { name: string; message: string }>;
	readonly onDidReceiveRuntimeMessageState: Event<Msg & { state: RuntimeOnlineState }>;
}

export interface SpanRun {
	readonly span: InlineExprSpan;
	readonly executionId: string;
	readonly mode: RuntimeCodeExecutionMode;
	readonly messages: SpanMessage[];
	/** Message kinds in arrival order, with ms since dispatch (for the S3 measurements). */
	readonly timeline: { kind: string; ms: number }[];
	readonly value: SpanValue;
	readonly totalMs: number;
}

function textData(data: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(data)) {
		if (typeof v === 'string') {
			out[k] = v;
		} else if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
			out[k] = v.join('');
		}
	}
	return out;
}

/** Run one span and resolve at the kernel's Idle message for its execution id. */
export function runSpan(
	session: InlineExprSession,
	span: InlineExprSpan,
	executionId: string,
	mode: RuntimeCodeExecutionMode,
	now: () => number = () => Date.now(),
	timeoutMs = 20000,
): Promise<SpanRun> {
	return new Promise<SpanRun>(resolve => {
		const store = new DisposableStore();
		const messages: SpanMessage[] = [];
		const timeline: { kind: string; ms: number }[] = [];
		const t0 = now();
		const note = (kind: string) => timeline.push({ kind, ms: now() - t0 });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let done = false;
		const finish = () => {
			if (done) { return; }
			done = true;
			if (timer) { clearTimeout(timer); }
			store.dispose();
			resolve({ span, executionId, mode, messages, timeline, value: spanValueFromMessages(messages), totalMs: now() - t0 });
		};
		store.add(session.onDidReceiveRuntimeMessageResult(m => {
			if (m.parent_id === executionId) { note('result'); messages.push({ kind: 'result', data: textData(m.data) }); }
		}));
		store.add(session.onDidReceiveRuntimeMessageOutput(m => {
			if (m.parent_id === executionId) { note('output'); messages.push({ kind: 'output', data: textData(m.data) }); }
		}));
		store.add(session.onDidReceiveRuntimeMessageStream(m => {
			if (m.parent_id === executionId) { note('stream'); messages.push({ kind: 'stream', text: m.text }); }
		}));
		store.add(session.onDidReceiveRuntimeMessageError(m => {
			if (m.parent_id === executionId) { note('error'); messages.push({ kind: 'error', name: m.name, message: m.message }); }
		}));
		store.add(session.onDidReceiveRuntimeMessageState(m => {
			if (m.parent_id === executionId && m.state === RuntimeOnlineState.Idle) { note('idle'); finish(); }
		}));
		timer = setTimeout(() => {
			messages.push({ kind: 'error', name: 'Timeout', message: `no Idle message within ${timeoutMs}ms` });
			finish();
		}, timeoutMs);
		session.execute(span.code, executionId, mode, RuntimeErrorBehavior.Continue).catch(err => {
			messages.push({ kind: 'error', name: 'ExecuteRejected', message: String(err) });
			finish();
		});
	});
}

/** Run spans strictly one at a time, in the order given (document order). */
export async function runSpans(
	session: InlineExprSession,
	spans: readonly InlineExprSpan[],
	mode: RuntimeCodeExecutionMode,
	idPrefix: string,
	isCancelled: () => boolean = () => false,
): Promise<SpanRun[]> {
	const runs: SpanRun[] = [];
	for (let i = 0; i < spans.length && !isCancelled(); i++) {
		runs.push(await runSpan(session, spans[i], `${idPrefix}-${i + 1}`, mode));
	}
	return runs;
}
