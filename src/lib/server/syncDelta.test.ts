import { describe, expect, it } from 'vitest';
import { mergeTombstones, planDelta, withoutTombstoned } from './syncDelta';

describe('delta sync planning', () => {
	it('moves no full records when manifests match', () => {
		const records = [{ id: 'a', updatedAt: 10, image: 'huge-data-url' }];
		expect(planDelta([{ id: 'a', updatedAt: 10 }], records)).toEqual({
			download: [],
			uploadIds: [],
			downloadTombstones: {},
			uploadTombstones: {}
		});
	});

	it('selects only the newer side of a changed record', () => {
		const records = [
			{ id: 'remote', updatedAt: 20 },
			{ id: 'local', updatedAt: 5 }
		];
		const plan = planDelta(
			[
				{ id: 'remote', updatedAt: 10 },
				{ id: 'local', updatedAt: 30 }
			],
			records
		);
		expect(plan.download.map((note) => note.id)).toEqual(['remote']);
		expect(plan.uploadIds).toEqual(['local']);
	});

	it('makes a newer permanent delete beat an older note', () => {
		const plan = planDelta([{ id: 'gone', updatedAt: 10 }], [{ id: 'gone', updatedAt: 10 }], {
			gone: 30
		});
		expect(plan.uploadTombstones).toEqual({ gone: 30 });
		expect(mergeTombstones({ gone: 10 }, { gone: 30 })).toEqual({ gone: 30 });
	});

	it('does not let a stale full snapshot revive a tombstoned note', () => {
		expect(withoutTombstoned([{ id: 'gone', updatedAt: 10 }], { gone: 30 })).toEqual([]);
	});

	it('sends a deleted label tombstone instead of re-uploading the stale label', () => {
		const plan = planDelta([], [{ id: 'label', updatedAt: 10, name: 'work' }], { label: 20 });
		expect(plan.download).toEqual([]);
		expect(plan.uploadIds).toEqual([]);
		expect(plan.uploadTombstones).toEqual({ label: 20 });
	});
});
