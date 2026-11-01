/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

// SPIKE (q2 EXR-16 S2a): what does the real QuartoOutputCacheService do with a q2-shaped record?
// Experiment code. It runs the real service over Positron's real FileService on the in-memory
// provider, so what it deletes, keeps and rewrites is observed, not read off the source.
//
// Q2_RECORD_FIXTURES: absolute path of crates/quarto-core/tests/fixtures/records in the q2 repo
// (it holds golden.ipynb, the record under test).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { QuartoOutputCacheService } from '../../browser/quartoOutputCacheService.js';

const GLOBAL_STORAGE = URI.from({ scheme: 'mem', path: '/globalStorage' });
const CACHE_DIR = URI.joinPath(GLOBAL_STORAGE, 'quarto-inline-outputs');
const TARGET_DOC = URI.from({ scheme: 'mem', path: '/project/doc.qmd' });

type Json = any;

function golden(): Json {
	const dir = process.env.Q2_RECORD_FIXTURES;
	if (!dir) {
		throw new Error('Set Q2_RECORD_FIXTURES to the absolute path of crates/quarto-core/tests/fixtures/records');
	}
	return JSON.parse(readFileSync(join(dir, 'golden.ipynb'), 'utf8'));
}

function setup() {
	const logService = new NullLogService();
	const fileService = new FileService(logService);
	fileService.registerProvider('mem', new InMemoryFileSystemProvider());
	const service = new QuartoOutputCacheService(
		fileService,
		logService,
		{ onWillShutdown: Event.None } as any,
		{ defaultProfile: { globalStorageHome: GLOBAL_STORAGE } } as any,
		{ onDidRunWorkingCopyFileOperation: Event.None } as any,
	);
	const put = (name: string, record: Json) =>
		fileService.writeFile(URI.joinPath(CACHE_DIR, name), VSBuffer.fromString(JSON.stringify(record)));
	const exists = (name: string) => fileService.exists(URI.joinPath(CACHE_DIR, name));
	const read = async (name: string): Promise<Json> =>
		JSON.parse((await fileService.readFile(URI.joinPath(CACHE_DIR, name))).value.toString());
	const list = async () => (await fileService.resolve(CACHE_DIR)).children?.map(c => c.name).sort() ?? [];
	// Where loadCache looks for a document's own file.
	const ownPath = (doc: URI) => (service as any)._getCachePath(doc).path.split('/').pop() as string;
	return { service, put, exists, read, list, ownPath };
}

const mimes = (o: { items?: { mime: string }[] }) => (o.items ?? []).map(i => i.mime);

describe('q2 record in Positron cache service (S2a spike)', () => {
	it('loadCache reads the golden record: ids, hashes, labels, outputs and mimes survive', async () => {
		const t = setup();
		const g = golden();
		await t.put(t.ownPath(TARGET_DOC), g);

		const doc = await t.service.loadCache(TARGET_DOC);
		expect(doc).toBeDefined();
		expect(doc!.cells.map(c => c.cellId)).toEqual(g.cells.map((c: Json) => c.metadata.quarto_cell_id));
		expect(doc!.cells.map(c => c.contentHash)).toEqual(g.cells.map((c: Json) => c.metadata.quarto_content_hash));
		expect(doc!.cells[2].label).toBe('fig-plot');
		expect(doc!.cells[3].label).toBeUndefined();

		// Cell 2: stream, execute_result, display_data.
		expect(doc!.cells[2].outputs.map(mimes)).toEqual([
			['application/vnd.code.notebook.stdout'],
			['text/plain'],
			['image/png', 'text/plain'],
		]);
		// An unknown mime (text/x-quarto-markdown) is kept as an ordinary item.
		expect(doc!.cells[3].outputs.map(mimes)).toEqual([['text/x-quarto-markdown']]);
		// Display metadata round-trips into outputMetadata.
		expect(doc!.cells[2].outputs[2].outputMetadata).toEqual({ a: 1, b: 2 });
		// A valid record is not deleted by loading it.
		expect(await t.exists(t.ownPath(TARGET_DOC))).toBe(true);
	});

	it('loadCache deletes a record with another quarto_cache_version, or none', async () => {
		for (const mutate of [
			(g: Json) => { g.metadata.quarto_cache_version = 2; },
			(g: Json) => { delete g.metadata.quarto_cache_version; },
			(g: Json) => { g.metadata.quarto_cache_version = '1'; },
		]) {
			const t = setup();
			const g = golden();
			mutate(g);
			await t.put(t.ownPath(TARGET_DOC), g);
			expect(await t.service.loadCache(TARGET_DOC)).toBeUndefined();
			expect(await t.exists(t.ownPath(TARGET_DOC))).toBe(false);
		}
	});

	it('loadCache deletes the whole record when one code cell has no outputs array', async () => {
		const t = setup();
		const g = golden();
		delete g.cells[1].outputs;
		await t.put(t.ownPath(TARGET_DOC), g);
		expect(await t.service.loadCache(TARGET_DOC)).toBeUndefined();
		expect(await t.exists(t.ownPath(TARGET_DOC))).toBe(false);
	});

	it('findCacheByContentHash skips (does not delete) a matching record that throws while loading', async () => {
		const t = setup();
		const g = golden();
		delete g.cells[1].outputs;
		await t.put('q2-record.ipynb', g);
		const result = await t.service.findCacheByContentHash(TARGET_DOC, [g.cells[0].metadata.quarto_content_hash]);
		expect(result).toBeUndefined();
		expect(await t.exists('q2-record.ipynb')).toBe(true);
	});

	it('mime data that is an array of lines or an object is stringified, not joined', async () => {
		const t = setup();
		const g = golden();
		g.cells[0].outputs = [{
			output_type: 'display_data',
			metadata: {},
			data: {
				'text/plain': ['line one\n', 'line two'],
				'application/json': { k: [1, 2] },
				'text/html': ['<b>', 'x</b>'],
			},
		}];
		await t.put(t.ownPath(TARGET_DOC), g);
		const doc = await t.service.loadCache(TARGET_DOC);
		const data = Object.fromEntries(doc!.cells[0].outputs[0].items.map(i => [i.mime, i.data]));
		console.log('S2a observed array/object mime data:', JSON.stringify(data));
		expect(data['text/plain']).toBe(JSON.stringify(['line one\n', 'line two']));
		expect(data['application/json']).toBe('{"k":[1,2]}');
		expect(data['text/html']).toBe(JSON.stringify(['<b>', 'x</b>']));
	});

	it('an output of an unknown output_type loads as an output with no items', async () => {
		const t = setup();
		const g = golden();
		g.cells[0].outputs = [{ output_type: 'something_new', data: { 'text/plain': 'x' } }];
		await t.put(t.ownPath(TARGET_DOC), g);
		const doc = await t.service.loadCache(TARGET_DOC);
		expect(doc!.cells[0].outputs).toHaveLength(1);
		expect(doc!.cells[0].outputs[0].items).toEqual([]);
	});

	it('hash-scan seed: one matching cell loads the whole record, deletes the file, and the rewrite drops q2 metadata', async () => {
		const t = setup();
		const g = golden();
		await t.put('q2-record.ipynb', g);

		// Only the last cell's hash matches (as for an unrelated document sharing one cell).
		const shared = g.cells[3].metadata.quarto_content_hash;
		const seeded = await t.service.findCacheByContentHash(TARGET_DOC, [shared]);
		expect(seeded).toBeDefined();
		expect(seeded!.cells).toHaveLength(4); // the whole record, not just the matching cell
		expect(await t.exists('q2-record.ipynb')).toBe(false); // consumed

		await t.service.flushCache(TARGET_DOC);
		expect(await t.list()).toEqual([t.ownPath(TARGET_DOC)]);
		const rewritten = await t.read(t.ownPath(TARGET_DOC));
		console.log('S2a rewritten notebook metadata keys:', Object.keys(rewritten.metadata));
		console.log('S2a rewritten cell[2] metadata:', JSON.stringify(rewritten.cells[2].metadata));
		console.log('S2a rewritten cell[2] output types:', rewritten.cells[2].outputs.map((o: Json) => o.output_type));

		// Notebook level: only Positron's fixed fields remain.
		expect(Object.keys(rewritten.metadata).sort()).toEqual(['last_updated', 'quarto_cache_version', 'quarto_source']);
		expect(rewritten.metadata.quarto_source).toBe(TARGET_DOC.toString());
		expect(rewritten.cells).toHaveLength(4);
		// Cell level: ids, hashes and labels kept; every other q2 key dropped.
		for (const [i, cell] of rewritten.cells.entries()) {
			expect(Object.keys(cell.metadata).filter((k: string) => k !== 'quarto_label').sort())
				.toEqual(['quarto_cell_id', 'quarto_content_hash']);
			expect(cell.metadata.quarto_content_hash).toBe(g.cells[i].metadata.quarto_content_hash);
			expect(cell.execution_count).toBeNull();
			expect(cell).not.toHaveProperty('id');
		}
		expect(rewritten.cells[2].metadata.quarto_label).toBe('fig-plot');
		// A display_data output comes back as execute_result.
		expect(rewritten.cells[2].outputs.map((o: Json) => o.output_type)).toEqual(['stream', 'execute_result', 'execute_result']);
	});

	it('hash-scan seed: no matching cell leaves the record alone', async () => {
		const t = setup();
		await t.put('q2-record.ipynb', golden());
		expect(await t.service.findCacheByContentHash(TARGET_DOC, ['0000000000000000'])).toBeUndefined();
		expect(await t.exists('q2-record.ipynb')).toBe(true);
	});
});
