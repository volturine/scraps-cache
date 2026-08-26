import { describe, expect, it } from 'vitest';
import type { Note } from './types';
import { normalizeBackup, prepareImportedNotes } from './backup';

const sourceNote: Note = {
	id: 'note',
	title: 'Imported',
	body: 'Body',
	color: 'default',
	pinned: false,
	archived: false,
	trashed: false,
	trashedAt: null,
	createdAt: 1,
	updatedAt: 2,
	reminder: null,
	labels: ['label'],
	fieldTimes: { title: 2, body: 1 },
	images: [{ id: 'image', mime: 'image/jpeg', dataUrl: 'data:', createdAt: 1 }]
};

describe('backup normalization', () => {
	it('rejects values without the required note and label collections', () => {
		expect(normalizeBackup(null)).toBeNull();
		expect(normalizeBackup({ notes: [] })).toBeNull();
		expect(normalizeBackup({ labels: [] })).toBeNull();
	});

	it('normalizes optional and malformed fields without retaining shared objects', () => {
		const source = {
			exportedAt: '123',
			notes: [
				{
					id: 'note',
					title: 42,
					body: null,
					labels: [1, 'two'],
					images: [{ id: 'image', mime: '', dataUrl: 5, createdAt: '10' }, { nope: true }]
				},
				null
			],
			labels: [{ id: 'label', name: 9, createdAt: '7' }, { name: 'missing id' }],
			tombstones: { kept: '12', discarded: 0 },
			ui: { layout: 'unexpected', dark: 'yes' }
		};
		const backup = normalizeBackup(source);

		expect(backup).toMatchObject({
			version: 4,
			exportedAt: 123,
			activeBoardId: '',
			tombstones: { kept: 12 },
			ui: { sidebarOpen: true, dark: null, layout: 'grid', view: 'notes' }
		});
		expect(backup?.notes).toEqual([
			expect.objectContaining({
				id: 'note',
				title: '42',
				body: '',
				labels: ['1', 'two'],
				images: [
					{
						id: 'image',
						mime: 'application/octet-stream',
						dataUrl: '',
						createdAt: 10
					}
				]
			})
		]);
		expect(backup?.labels).toEqual([
			{
				id: 'label',
				name: '9',
				createdAt: 7,
				updatedAt: 7
			}
		]);

		(source.notes[0] as { labels: Array<string | number> }).labels.push('later');
		expect(backup?.notes[0].labels).toEqual(['1', 'two']);
	});

	it('never retains sync identity from the backup file', () => {
		const backup = normalizeBackup({
			notes: [{ id: 'note' }],
			labels: [],
			sync: { syncKey: 'root-secret', lastSync: 42 }
		});
		expect(backup).not.toHaveProperty('sync');
		expect(JSON.stringify(backup)).not.toContain('root-secret');
	});

	it('refreshes timestamps while retaining IDs for replacement imports', () => {
		const [note] = prepareImportedNotes([sourceNote], 'replace', 100);

		expect(note).toMatchObject({ id: 'note', createdAt: 100, updatedAt: 100, trashedAt: null });
		expect(note.images).toEqual([expect.objectContaining({ id: 'image', createdAt: 100 })]);
		expect(new Set(Object.values(note.fieldTimes ?? {}))).toEqual(new Set([100]));
	});

	it('regenerates note and attachment IDs for additive imports', () => {
		const [note] = prepareImportedNotes([sourceNote], 'keep', 100);

		expect(note.id).not.toBe(sourceNote.id);
		expect(note.images?.[0].id).not.toBe(sourceNote.images?.[0].id);
		expect(note).toMatchObject({ createdAt: 100, updatedAt: 100 });
	});
});
