import { describe, expect, it } from 'vitest';
import { mergeLabels, mergeNotes } from './syncMerge';

describe('sync conflict rules', () => {
	it('keeps the newer note and its attached image payload', () => {
		const stored = [{ id: 'n1', updatedAt: 10, title: 'old' }];
		const incoming = [
			{
				id: 'n1',
				updatedAt: 20,
				title: 'new',
				images: [{ id: 'image', dataUrl: 'data:image/png;base64,AA==' }]
			}
		];
		expect(mergeNotes(incoming, stored)).toEqual(incoming);
	});

	it('does not let a stale client overwrite a newer server note', () => {
		const stored = [{ id: 'n1', updatedAt: 20, title: 'server' }];
		const incoming = [{ id: 'n1', updatedAt: 10, title: 'stale' }];
		expect(mergeNotes(incoming, stored)).toEqual(stored);
	});

	it('uses label updatedAt for rename conflicts', () => {
		const stored = [{ id: 'l1', name: 'old name', createdAt: 1, updatedAt: 5 }];
		const incoming = [{ id: 'l1', name: 'renamed', createdAt: 1, updatedAt: 6 }];
		expect(mergeLabels(incoming, stored)).toEqual(incoming);
	});
});
