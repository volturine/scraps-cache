import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import { noteNeedsDurableWrite } from './notes.svelte';

function note(body: string, bodyTime: number): Note {
	return {
		id: 'note-1',
		title: 'A newer local title keeps the overall timestamp high',
		body,
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 100,
		reminder: null,
		labels: [],
		images: [],
		fieldTimes: { title: 100, body: bodyTime }
	};
}

describe('downloaded note persistence', () => {
	it('persists a field-level merge even when the whole-note timestamp is unchanged', () => {
		const local = note('old remote field', 10);
		const merged = note('new remote field', 90);

		expect(merged.updatedAt).toBe(local.updatedAt);
		expect(noteNeedsDurableWrite(local, merged)).toBe(true);
	});
});
