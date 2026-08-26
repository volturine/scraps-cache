import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BackupImportModeDialog from './BackupImportModeDialog.svelte';

describe('BackupImportModeDialog', () => {
	it('offers additive and replacement import modes explicitly', async () => {
		const onSelect = vi.fn();
		render(BackupImportModeDialog, { props: { onSelect, onClose: vi.fn() } });

		await fireEvent.click(screen.getByRole('button', { name: /keep local notes/i }));
		await fireEvent.click(screen.getByRole('button', { name: /replace local data/i }));

		expect(onSelect).toHaveBeenNthCalledWith(1, 'keep');
		expect(onSelect).toHaveBeenNthCalledWith(2, 'replace');
	});
});
