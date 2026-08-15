import { fireEvent, render, screen } from '@testing-library/svelte';
import { StickyNote } from '@lucide/svelte';
import { describe, expect, it, vi } from 'vitest';
import EmptyState from './EmptyState.svelte';

describe('EmptyState', () => {
	it('offers a button action when one is available', async () => {
		const onAction = vi.fn();
		render(EmptyState, {
			props: {
				icon: StickyNote,
				description: 'Start with a note.',
				actionLabel: 'Create note',
				onAction
			}
		});

		const action = screen.getByRole('button', { name: 'Create note' });
		expect(action).toBeTruthy();
		await fireEvent.click(action);
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('uses a link for navigation actions', () => {
		render(EmptyState, {
			props: {
				icon: StickyNote,
				description: 'This label is gone.',
				actionLabel: 'Go to Notes',
				href: '/'
			}
		});

		expect(screen.getByRole('link', { name: 'Go to Notes' }).getAttribute('href')).toBe('/');
	});
});
