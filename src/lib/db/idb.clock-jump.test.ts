import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSyncOutbox, commitSyncControl, getSyncOutboxKeys, putNote } from '$lib/db/idb';
import type { Note } from '$lib/types';

function note(title: string): Note {
	return {
		id: 'clock-note',
		title,
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: []
	};
}

/**
 * Issue #84: outbox generations are wall-clock timestamps. A backward system
 * clock jump between the sync snapshot (`outboxSnapshotAt`) and a mid-sync
 * edit stamps the new marker BELOW the snapshot time, so the blanket
 * acknowledgement `{ keys, through: outboxSnapshotAt }` clears a marker whose
 * content was never uploaded.
 *
 * Engine sequence reproduced here (see sync.svelte.ts):
 *   1. sync starts at T=200, capturing outboxSnapshotAt=200
 *   2. clock jumps back to T=100
 *   3. user edits the very note being uploaded -> marker stamped at 100
 *   4. upload of the OLDER content succeeds -> key added to acknowledgedOutbox
 *   5. commitSyncControl acks with through=200 -> fresh marker deleted
 */
describe('outbox generations under a backward clock jump', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps a marker stamped after the sync snapshot when the clock jumps backward', async () => {
		const now = vi.spyOn(Date, 'now');
		now.mockReturnValue(200);
		await clearSyncOutbox(await getSyncOutboxKeys());

		// Clock jumps backward before the mid-sync edit lands.
		now.mockReturnValue(100);
		await putNote(note('edited mid-sync'), ['note:clock-note']);
		expect(await getSyncOutboxKeys()).toEqual(['note:clock-note']);

		await commitSyncControl([['test-cursor', 1]], [{ keys: ['note:clock-note'], through: 200 }]);

		expect(await getSyncOutboxKeys()).toEqual(['note:clock-note']);
	});
});
