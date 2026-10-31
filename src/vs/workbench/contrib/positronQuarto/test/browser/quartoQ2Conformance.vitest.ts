/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

// SPIKE (q2 EXR-16 S1): where do Positron's cell parser and content hash disagree with q2's?
// Experiment code: it records observations; only the hash vectors with known q2 values assert.

import { URI } from '../../../../../base/common/uri.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { createTestContainer } from '../../../../../test/vitest/positronTestContainer.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { QuartoDocumentModel } from '../../browser/quartoDocumentModel.js';
import { createTestRuntimeStartupService } from './quartoTestRuntimeStartupService.js';

// Same recipe as the private `computeContentHash` in quartoDocumentModel.ts.
function hash16(content: string): string {
	const sha = new StringSHA1();
	sha.update(content);
	return sha.digest().substring(0, 16);
}

describe('q2 conformance (S1 spike)', () => {
	const ctx = createTestContainer().build();
	const logService = new NullLogService();
	const startup = createTestRuntimeStartupService();

	it('hash vectors computed with node crypto in the plan review', () => {
		expect(hash16('x <- 1')).toBe('4390f67858f3f1c7');
		expect(hash16('café')).toBe('f424452a9673918c');
		expect(hash16('😀')).toBe('9c533688a979a858');
		expect(hash16("#| label: fig-é\nx <- 'é😀'")).toBe('774a7e618b133ed6');
	});

	it('lone surrogate: observed value (not asserted)', () => {
		const lone = hash16('a\ud800b');
		const replaced = hash16('a�b');
		console.log(`S1 lone-surrogate hash=${lone} replacement-char hash=${replaced} equal=${lone === replaced}`);
	});

	const docs: Record<string, string> = {
		plain: '```{python}\nx = 1\n```\n',
		labelComment: '```{python}\n#| label: fig-a\nx = 1\n```\n',
		braceLabel: '```{r, label=foo}\nx <- 1\n```\n',
		braceLabelDotted: '```{python #bar}\nx = 1\n```\n',
		dottedFence: '```{.python}\nx = 1\n```\n',
		marimoSpaced: '```{python .marimo}\nx = 1\n```\n',
		marimoDotted: '```{python.marimo}\nx = 1\n```\n',
		blockquote: '> ```{python}\n> x = 1\n> ```\n',
		list: '- item\n\n  ```{python}\n  x = 1\n  ```\n',
		fourBacktick: '````markdown\n```{python}\nx = 1\n```\n````\n',
		displayFence: '```text\n```{python}\nx = 1\n```\n```\n',
		tildeFence: '~~~{python}\nx = 1\n~~~\n',
		crlf: '```{python}\r\nx = 1\r\n```\r\n',
		rawHtml: '```{=html}\n<b>x</b>\n```\n',
		twoCells: '```{python}\na = 1\n```\n\ntext\n\n```{r}\nb <- 2\n```\n',
	};

	for (const [name, content] of Object.entries(docs)) {
		it(`observe: ${name}`, () => {
			const textModel = createTextModel(content, null, undefined, URI.file('/s1.qmd'));
			ctx.disposables.add(textModel);
			const model = new QuartoDocumentModel(textModel, logService, startup);
			ctx.disposables.add(model);
			const cells = model.cells.map(c => ({
				id: c.id, language: c.language, label: c.label, hash: c.contentHash, lines: `${c.startLine}-${c.endLine}`,
			}));
			console.log(`S1 ${name} => ${JSON.stringify(cells)}`);
		});
	}
});
