/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Spike S3 (q2 interop): "Run Inline Expressions" debug command. Picks an
// execution mode, runs every `{lang} expr` span on the document's kernel, draws
// each value after its span as injected text, and logs a measurement summary.

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { RuntimeCodeExecutionMode } from '../../../services/languageRuntime/common/languageRuntimeService.js';
import { IQuartoKernelManager } from './quartoKernelManager.js';
import { IQuartoDocumentModelService } from './quartoDocumentModelService.js';
import { findInlineExprSpans } from './quartoInlineExpr.js';
import { runSpans, SpanRun } from './quartoInlineExprExecutor.js';
import { QUARTO_CATEGORY } from './quartoCommands.js';

function describeRun(r: SpanRun): string {
	const kinds = r.timeline.map(t => `${t.kind}@${t.ms}`).join(' ');
	return `${r.span.line}:${r.span.startColumn} \`${r.span.code}\` -> ${r.value.ok ? JSON.stringify(r.value.text) : 'ERROR ' + r.value.error} [${r.totalMs}ms; ${kinds}]`;
}

registerAction2(class RunInlineExpressionsAction extends Action2 {
	constructor() {
		super({
			id: 'positronQuarto.spike.runInlineExpressions',
			title: localize2('quarto.spike.runInline', "Spike: Run Inline Expressions"),
			category: QUARTO_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editor = editorService.activeTextEditorControl;
		const quickInput = accessor.get(IQuickInputService);
		const kernelManager = accessor.get(IQuartoKernelManager);
		const modelService = accessor.get(IQuartoDocumentModelService);
		const log = accessor.get(ILogService);
		const notify = accessor.get(INotificationService);
		const fail = (msg: string) => { log.warn(`[spike S3] ${msg}`); notify.info(`[spike S3] ${msg}`); };
		if (!isCodeEditor(editor) || !editor.hasModel()) {
			fail('no active code editor (click into the .qmd editor first)');
			return;
		}
		const textModel = editor.getModel();
		const language = modelService.getModel(textModel).primaryLanguage;
		if (!language) {
			fail('document has no primary language');
			return;
		}
		const spans = findInlineExprSpans(textModel.getLinesContent(), language);
		const pick = await quickInput.pick(
			[RuntimeCodeExecutionMode.Transient, RuntimeCodeExecutionMode.Silent, RuntimeCodeExecutionMode.Interactive]
				.map(m => ({ label: m })),
			{ placeHolder: `Execution mode for ${spans.length} span(s)` });
		if (!pick) {
			return;
		}
		const mode = pick.label as RuntimeCodeExecutionMode;
		log.info(`[spike S3] start mode=${mode} language=${language} spans=${spans.length}`);
		notify.info(`[spike S3] ${mode}: ${spans.length} ${language} span(s); starting kernel`);
		const session = await kernelManager.ensureKernelForDocument(textModel.uri);
		if (!session) {
			fail('no kernel session');
			return;
		}
		log.info('[spike S3] kernel ready, executing');
		const t0 = Date.now();
		const runs = await runSpans(session, spans, mode, `spike-${generateUuid()}`);
		const decorations: IModelDeltaDecoration[] = runs.map(r => {
			// allow-any-unicode-next-line
			const text = r.value.ok ? (r.value.text ?? '') : `⚠ ${r.value.error}`;
			return {
				range: new Range(r.span.line, r.span.startColumn, r.span.line, r.span.endColumn),
				options: {
					description: 'quarto-spike-inline-expr',
					className: 'quarto-spike-inline-span',
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					after: {
						// allow-any-unicode-next-line
						content: ` ⟹ ${text.replace(/\s+/g, ' ')}`,
						inlineClassName: 'quarto-spike-inline-value',
					},
				},
			};
		});
		const collection = editor.createDecorationsCollection(decorations);
		const report = `[spike S3] mode=${mode} spans=${runs.length} total=${Date.now() - t0}ms decorations=${collection.length} uri=${textModel.uri.toString()} firstRange=${collection.getRange(0)?.toString()}\n${runs.map(describeRun).join('\n')}`;
		notify.info(`[spike S3] done: ${runs.length} span(s) in ${Date.now() - t0}ms, ${collection.length} decoration(s); report opened in a new editor`);
		log.info(report);
		// The Positron log is hard to find in a dev build, so also show the report as text.
		await editorService.openEditor({ resource: undefined, contents: report, languageId: 'plaintext' }, SIDE_GROUP);
	}
});
