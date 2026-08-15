import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReminderNotificationSettings from './ReminderNotificationSettings.svelte';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ReminderNotificationSettings', () => {
	it('requests permission and shows the device as enabled', async () => {
		const notification = {
			permission: 'default' as NotificationPermission,
			requestPermission: vi.fn(async () => {
				notification.permission = 'granted';
				return 'granted' as NotificationPermission;
			})
		};
		vi.stubGlobal('Notification', notification);

		render(ReminderNotificationSettings);
		await fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

		await waitFor(() => {
			expect(screen.getByText('Enabled on this device')).toBeTruthy();
		});
		expect(notification.requestPermission).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
	});
});
