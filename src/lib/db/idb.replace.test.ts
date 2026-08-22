const PID = 'device-local';
import { describe, expect, it } from 'vitest';
import type { Label, Note, NoteImage } from '$lib/types';
import { getAllLabels, getAllNotesMetadata, putNote, replaceAllDeviceData } from './idb';

function note(id: string, title: string): Note {
	return {
		id,
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

function label(id: string, name: string): Label {
	return { id, name, createdAt: 1, updatedAt: 1 };
}

describe('replaceAllDeviceData', () => {
	it('keeps the downloaded device state when an earlier same-note save is still queued', async () => {
		const firstLocalSave = putNote(PID, note('local', 'first local write'));
		const staleLocalSave = putNote(PID, note('local', 'late local write'));
		const replacement = replaceAllDeviceData(
			PID,
			[note('cloud', 'downloaded cloud note')],
			[label('cloud-label', 'Cloud')]
		);

		await Promise.all([firstLocalSave, staleLocalSave, replacement]);

		expect((await getAllNotesMetadata(PID)).map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: 'cloud', title: 'downloaded cloud note' }
		]);
		expect(await getAllLabels(PID)).toEqual([label('cloud-label', 'Cloud')]);
	});

	it('still writes the remaining notes and labels when one note fails mid-replacement', async () => {
		const broken = {
			...note('broken', 'undecodable attachment'),
			images: [
				{
					id: 'img',
					mime: 'image/png',
					dataUrl: 'not-a-valid-url',
					createdAt: 1
				} as NoteImage
			]
		};
		const replacement = replaceAllDeviceData(
			PID,
			[broken, note('good', 'survives')],
			[label('kept-label', 'Kept')]
		);

		await expect(replacement).rejects.toThrow('Not a valid image URL');

		expect((await getAllNotesMetadata(PID)).map(({ id }) => id)).toEqual(['good']);
		expect(await getAllLabels(PID)).toEqual([label('kept-label', 'Kept')]);
	});
});
