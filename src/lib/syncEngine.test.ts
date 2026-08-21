import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import { planDeletableKeys, reconcileBaseline, syncRoundHasMore } from './syncEngine';

function note(id: string, imageIds: string[] = []): Note {
	return {
		id,
		title: id,
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: [],
		images: imageIds.map((imageId) => ({
			id: imageId,
			mime: 'image/jpeg',
			dataUrl: '',
			createdAt: 1
		}))
	};
}

describe('incremental sync engine', () => {
	it('does not delete attachments until catch-up has drained', () => {
		const planned = planDeletableKeys({
			recordIds: { 'attachment:pic': 'env-1', 'note:n1': 'env-2' },
			notes: [],
			labels: [],
			boards: [],
			tombstones: { notes: {}, labels: {}, boards: {} },
			pullOnly: false,
			catchUpComplete: false
		});
		expect(planned).toEqual([]);
	});

	it('deletes an unused attachment only after catch-up completes', () => {
		const planned = planDeletableKeys({
			recordIds: { 'attachment:pic': 'env-1', 'note:n1': 'env-2' },
			notes: [note('n1')],
			labels: [],
			boards: [],
			tombstones: { notes: {}, labels: {}, boards: {} },
			pullOnly: false,
			catchUpComplete: true
		});
		expect(planned).toEqual(['attachment:pic']);
	});

	it('does not delete an old photo while a replacement is not yet on the relay', () => {
		const planned = planDeletableKeys({
			recordIds: { 'attachment:old': 'env-1', 'note:n1': 'env-2' },
			notes: [note('n1', ['new'])],
			labels: [],
			boards: [],
			tombstones: { notes: {}, labels: {}, boards: {} },
			pullOnly: false,
			catchUpComplete: true
		});
		expect(planned).toEqual([]);
	});

	it('never deletes slots during pull-only replace', () => {
		const planned = planDeletableKeys({
			recordIds: { 'attachment:pic': 'env-1', 'note:n1': 'env-2' },
			notes: [],
			labels: [],
			boards: [],
			tombstones: { notes: {}, labels: {}, boards: {} },
			pullOnly: true,
			catchUpComplete: true
		});
		expect(planned).toEqual([]);
	});

	it('runs another round when catch-up reveals an orphaned photo slot', () => {
		const pendingDeletes =
			planDeletableKeys({
				recordIds: { 'attachment:pic': 'env-1', 'note:n1': 'env-2' },
				notes: [],
				labels: [],
				boards: [],
				tombstones: { notes: { n1: 2 }, labels: {}, boards: {} },
				pullOnly: false,
				catchUpComplete: true
			}).length > 0;

		expect(
			syncRoundHasMore({
				remoteHasMore: false,
				remainingUploads: false,
				pendingDeletes
			})
		).toBe(true);
	});

	it('stops after the cleanup round removes the orphaned slot id', () => {
		expect(
			syncRoundHasMore({
				remoteHasMore: false,
				remainingUploads: false,
				pendingDeletes: false
			})
		).toBe(false);
	});

	it('re-uploads when local merge beats a stale remote fingerprint', () => {
		const result = reconcileBaseline({
			previous: { 'note:n1': 'local-fp' },
			uploaded: {},
			remote: { 'note:n1': 'stale-fp' },
			merged: { 'note:n1': 'local-fp' },
			currentKeys: new Set(['note:n1']),
			referencedAttachments: new Set()
		});
		expect(result.dirtyKeys).toEqual(['note:n1']);
		expect(result.baseline['note:n1']).toBe('stale-fp');
		expect(result.ackKeys).toEqual([]);
	});

	it('acks an outbox key only when merged state matches the upload', () => {
		const result = reconcileBaseline({
			previous: {},
			uploaded: { 'note:n1': 'sent-fp' },
			remote: {},
			merged: { 'note:n1': 'sent-fp' },
			currentKeys: new Set(['note:n1']),
			referencedAttachments: new Set()
		});
		expect(result.ackKeys).toEqual(['note:n1']);
		expect(result.dirtyKeys).toEqual([]);
		expect(result.baseline['note:n1']).toBe('sent-fp');
	});
});
