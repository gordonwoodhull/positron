/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

import { Emitter } from '../../../../../base/common/event.js';
import { RuntimeCodeExecutionMode, RuntimeOnlineState } from '../../../../services/languageRuntime/common/languageRuntimeService.js';
import { runSpans, InlineExprSession } from '../../browser/quartoInlineExprExecutor.js';
import { findInlineExprSpans } from '../../browser/quartoInlineExpr.js';

type Reply = (id: string, e: FakeSession) => void;

class FakeSession implements InlineExprSession {
	readonly out = new Emitter<any>();
	readonly res = new Emitter<any>();
	readonly stream = new Emitter<any>();
	readonly err = new Emitter<any>();
	readonly state = new Emitter<any>();
	readonly onDidReceiveRuntimeMessageOutput = this.out.event;
	readonly onDidReceiveRuntimeMessageResult = this.res.event;
	readonly onDidReceiveRuntimeMessageStream = this.stream.event;
	readonly onDidReceiveRuntimeMessageError = this.err.event;
	readonly onDidReceiveRuntimeMessageState = this.state.event;
	readonly executed: { code: string; id: string; mode: RuntimeCodeExecutionMode }[] = [];
	constructor(private readonly replies: Record<string, Reply>) { }
	async execute(code: string, id: string, mode: RuntimeCodeExecutionMode) {
		this.executed.push({ code, id, mode });
		setTimeout(() => {
			this.replies[code]?.(id, this);
			this.state.fire({ parent_id: id, state: RuntimeOnlineState.Idle });
		}, 0);
	}
}

const spans = (doc: string) => findInlineExprSpans(doc.split('\n'), 'python');

describe('runSpans', () => {
	it('runs spans one at a time in document order and extracts values', async () => {
		const s = new FakeSession({
			'1 + 1': (id, e) => e.res.fire({ parent_id: id, data: { 'text/plain': '2' } }),
			'show()': (id, e) => e.out.fire({ parent_id: id, data: { 'text/plain': 'shown' } }),
			'x = 3': () => { },
		});
		const runs = await runSpans(s, spans('`{python} 1 + 1` `{python} show()`\n`{python} x = 3`'), RuntimeCodeExecutionMode.Silent, 'q');
		expect(s.executed.map(e => [e.id, e.code, e.mode])).toEqual([
			['q-1', '1 + 1', 'silent'], ['q-2', 'show()', 'silent'], ['q-3', 'x = 3', 'silent']]);
		expect(runs.map(r => r.value)).toEqual([
			{ ok: true, text: '2' }, { ok: true, text: 'shown' }, { ok: true, text: undefined }]);
		expect(runs[0].timeline.map(t => t.kind)).toEqual(['result', 'idle']);
	});

	it('ignores messages for other execution ids and reports errors', async () => {
		const s = new FakeSession({
			'boom': (id, e) => {
				e.res.fire({ parent_id: 'other', data: { 'text/plain': 'nope' } });
				e.err.fire({ parent_id: id, name: 'NameError', message: 'boom' });
			},
		});
		const [run] = await runSpans(s, spans('`{python} boom`'), RuntimeCodeExecutionMode.Transient, 'q');
		expect(run.value).toEqual({ ok: false, error: 'NameError: boom' });
		expect(run.messages).toHaveLength(1);
	});

	it('stops when cancelled', async () => {
		const s = new FakeSession({});
		let n = 0;
		const runs = await runSpans(s, spans('`{python} a` `{python} b`'), RuntimeCodeExecutionMode.Silent, 'q', () => n++ >= 1);
		expect(runs).toHaveLength(1);
	});
});
