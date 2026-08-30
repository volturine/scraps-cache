import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('$lib/editorContext', () => ({
	useEditorActions: () => ({ startNewNote: vi.fn(), closeNote: vi.fn() })
}));

import { syncStore } from '$lib/stores/sync.svelte';
import Topbar from './Topbar.svelte';

afterEach(() => {
	syncStore.lastError = null;
	syncStore.usage = null;
});

describe('Topbar sync status', () => {
	it('uses only the cloud color and accessible label to surface persistent sync attention', async () => {
		syncStore.usage = {
			ciphertextBytes: 700,
			envelopeCount: 1,
			storageBytes: 850,
			maxBytes: 1_000
		};
		const { container } = render(Topbar);
		const icon = container.querySelector('[data-scrapscache-sync-icon]');

		expect(screen.getByRole('button', { name: 'Sync settings, storage nearly full' })).toBeTruthy();
		expect(icon?.getAttribute('class')).toContain('text-[var(--scrapscache-warning)]');

		syncStore.lastError = 'Sync network error';
		await vi.waitFor(() =>
			expect(
				screen.getByRole('button', { name: 'Sync settings, sync needs attention' })
			).toBeTruthy()
		);
		expect(icon?.getAttribute('class')).toContain('text-[var(--scrapscache-danger)]');
	});
});
