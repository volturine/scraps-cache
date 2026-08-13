import { describe, expect, it } from 'vitest';
import { normalizeBackup } from './backup';

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
			ui: { sidebarOpen: true, dark: null, layout: 'grid', view: 'notes' },
			sync: null
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
});
