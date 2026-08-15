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
		expect(screen.getByText('Not set')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }));

		await waitFor(() => {
			expect(screen.getByText('Enabled')).toBeTruthy();
		});
		expect(notification.requestPermission).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
	});

	it('shows denied permission as disabled without recovery instructions', () => {
		vi.stubGlobal('Notification', {
			permission: 'denied',
			requestPermission: vi.fn()
		});

		render(ReminderNotificationSettings);

		expect(screen.getByText('Disabled')).toBeTruthy();
		expect(screen.queryByText(/settings/i)).toBeNull();
		expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
	});

	it('refreshes after permission is changed in device settings', async () => {
		const notification = {
			permission: 'denied' as NotificationPermission,
			requestPermission: vi.fn()
		};
		vi.stubGlobal('Notification', notification);
		render(ReminderNotificationSettings);

		notification.permission = 'granted';
		window.dispatchEvent(new Event('focus'));

		await waitFor(() => expect(screen.getByText('Enabled')).toBeTruthy());
	});
});
