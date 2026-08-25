const PID = 'device-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearAllNotes,
	clearSyncOutbox,
	getSyncOutboxKeys,
	markSyncOutbox,
	putNote
} from '$lib/db/idb';
import { syncStore } from './sync.svelte';
import { notesStore } from './notes.svelte';
import { createSyncIdentity } from '$lib/syncPairing';
import type { Note } from '$lib/types';

function noteWithPhoto(dataUrl: string): Note {
	return {
		id: 'photo-note',
		title: 'Photo',
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
		images: [
			{
				id: 'photo-1',
				mime: 'image/png',
				dataUrl,
				createdAt: 1,
				contentHash: 'photo-hash'
			}
		]
	};
}

describe('syncing when a note closes', () => {
	beforeEach(async () => {
		await clearSyncOutbox(PID, await getSyncOutboxKeys(PID));
		syncStore.account = {
			syncKey: 'test-key',
			accountId: 'test-account',
			authSecret: 'test-secret',
			pairingCode: 'test-code'
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		syncStore.account = null;
		notesStore.notes = [];
		(
			notesStore as unknown as { attachmentHydrationFailures: Set<string> }
		).attachmentHydrationFailures.clear();
		await clearAllNotes(PID);
		await clearSyncOutbox(PID, await getSyncOutboxKeys(PID));
	});

	it('skips the cloud request when there are no pending records', async () => {
		const flush = vi.spyOn(notesStore, 'flushSync').mockResolvedValue(true);

		expect(await notesStore.syncPendingChanges()).toBe(false);
		expect(flush).not.toHaveBeenCalled();
	});

	it('flushes the debounce immediately when a record is pending', async () => {
		await markSyncOutbox(PID, ['note:note-1']);
		const flush = vi.spyOn(notesStore, 'flushSync').mockResolvedValue(true);

		expect(await notesStore.syncPendingChanges()).toBe(true);
		expect(flush).toHaveBeenCalledOnce();
		expect(flush).toHaveBeenCalledWith(true);
	});

	it('asks the cloud request to spin the icon', async () => {
		await markSyncOutbox(PID, ['note:note-1']);
		vi.spyOn(syncStore, 'needsCurrentStateBootstrap').mockResolvedValue(false);
		const sync = vi.spyOn(syncStore, 'sync').mockResolvedValue({
			success: true,
			notes: [],
			labels: []
		});

		expect(await notesStore.syncPendingChanges()).toBe(true);
		expect(sync.mock.calls[0]?.[6]).toBe(true);
	});

	it('manual sync cancels the pending automatic pass and settles dirty state', async () => {
		await markSyncOutbox(PID, ['note:note-1']);
		(notesStore as unknown as { dirty: boolean }).dirty = true;
		(notesStore as unknown as { scheduleSyncPush(): void }).scheduleSyncPush();
		vi.spyOn(
			notesStore as unknown as { queueSync(indicate: boolean): Promise<boolean> },
			'queueSync'
		).mockImplementation(async (indicate) => {
			expect(indicate).toBe(true);
			await clearSyncOutbox(PID, ['note:note-1']);
			return true;
		});

		expect(await notesStore.syncWithCloudManual()).toBe(true);
		expect((notesStore as unknown as { dirty: boolean }).dirty).toBe(false);
		expect(
			(notesStore as unknown as { syncPushTimer: ReturnType<typeof setTimeout> | null })
				.syncPushTimer
		).toBeNull();
	});

	it('keeps an existing attachment hydration warning visible across retries', async () => {
		syncStore.account = createSyncIdentity();
		notesStore.notes = [noteWithPhoto('')];
		const failures = (notesStore as unknown as { attachmentHydrationFailures: Set<string> })
			.attachmentHydrationFailures;
		failures.add('photo-note');
		notesStore.lastPersistError = 'Could not load attachment';
		vi.spyOn(
			notesStore as unknown as { ensureNoteAttachments(noteId: string): Promise<void> },
			'ensureNoteAttachments'
		).mockResolvedValue();
		const rewind = vi.spyOn(syncStore, 'rewindCursorForAttachmentRecovery').mockResolvedValue();
		vi.spyOn(syncStore, 'sync').mockImplementation(async () => {
			syncStore.lastError = null;
			return { success: true, notes: [], labels: [] };
		});

		expect(await notesStore.syncWithCloudManual()).toBe(true);
		expect(syncStore.lastError).toMatch(/photos could not be prepared/i);
		expect(await notesStore.syncWithCloudManual()).toBe(true);
		expect(syncStore.lastError).toMatch(/photos could not be prepared/i);
		expect(rewind).toHaveBeenCalledTimes(2);

		failures.clear();
	});

	it('treats attachment metadata without its IndexedDB blob as a hydration failure', async () => {
		const note = noteWithPhoto('');
		await putNote(PID, note);
		notesStore.notes = [note];

		await notesStore.ensureNoteAttachments(note.id);

		const failures = (notesStore as unknown as { attachmentHydrationFailures: Set<string> })
			.attachmentHydrationFailures;
		expect(failures.has(note.id)).toBe(true);
		expect(notesStore.lastPersistError).toMatch(/missing from device storage/i);
	});

	it('does not loop automatic sync when an outbox record remains queued', async () => {
		notesStore.notes = [noteWithPhoto('')];
		(
			notesStore as unknown as { attachmentHydrationFailures: Set<string> }
		).attachmentHydrationFailures.add('photo-note');
		await markSyncOutbox(PID, ['attachment:photo-1']);
		(notesStore as unknown as { dirty: boolean }).dirty = true;
		vi.spyOn(
			notesStore as unknown as { queueSync(indicate: boolean): Promise<boolean> },
			'queueSync'
		).mockResolvedValue(true);

		expect(await notesStore.flushSync()).toBe(true);
		expect(
			(notesStore as unknown as { syncPushTimer: ReturnType<typeof setTimeout> | null })
				.syncPushTimer
		).toBeNull();
	});

	it('does not loop automatic sync after a relay failure', async () => {
		await markSyncOutbox(PID, ['note:note-1']);
		(notesStore as unknown as { dirty: boolean }).dirty = true;
		vi.spyOn(
			notesStore as unknown as { queueSync(indicate: boolean): Promise<boolean> },
			'queueSync'
		).mockResolvedValue(false);

		expect(await notesStore.flushSync()).toBe(false);
		expect((notesStore as unknown as { dirty: boolean }).dirty).toBe(true);
		expect(
			(notesStore as unknown as { syncPushTimer: ReturnType<typeof setTimeout> | null })
				.syncPushTimer
		).toBeNull();
		expect(await getSyncOutboxKeys(PID)).toEqual(['note:note-1']);
	});

	it('hydrates every attachment before taking the integrity snapshot', async () => {
		const dataUrl = 'data:image/png;base64,QQ==';
		await putNote(PID, noteWithPhoto(dataUrl));
		notesStore.notes = [noteWithPhoto('')];
		syncStore.account = createSyncIdentity();
		const sync = vi
			.spyOn(syncStore, 'sync')
			.mockResolvedValue({ success: true, notes: [], labels: [] });

		expect(await notesStore.syncWithCloudManual()).toBe(true);
		expect(sync.mock.calls[0]?.[0][0].images?.[0]?.dataUrl).toBe(dataUrl);
	});
});
