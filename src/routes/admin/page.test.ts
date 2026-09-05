import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminPage from './+page.svelte';

const snapshot = {
	generatedAt: 1_000,
	storage: { ciphertextBytes: 4_000, storageBytes: 5_024, gigabytes: 0.000005, envelopes: 2 },
	accounts: { total: 3, active: { '1': 1, '7': 2, '30': 3 }, staleForRetention: null },
	activity: {
		syncRequests: 7,
		syncUploadEnvelopes: 2,
		syncDeleteSlots: 0,
		rateLimited: 0,
		sqliteBusy: 0,
		reminderWakesSent: 0,
		reminderWakesGone: 0,
		reminderWakesFailed: 0
	},
	retention: {
		enabled: false,
		inactiveDays: 0,
		lastRunAt: 0,
		lastDeletedAccounts: 0,
		deletedAccountsTotal: 0,
		lastPurgedSlots: 0,
		failures: 0,
		lastError: null
	},
	quotas: { maxAccountBytes: 100_000_000 },
	features: { mcpEnabledAccounts: 1 }
};

const disabledAccount = {
	usage: {
		envelopeCount: 2,
		ciphertextBytes: 4_000,
		storageBytes: 5_024,
		maxBytes: 100_000_000,
		overridden: false
	},
	mcp: { enabled: false, enabledAt: null, updatedAt: null }
};

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare Access admin console', () => {
	it('monitors the relay and manages storage and MCP for a selected account', async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === '/admin/api/status') return Response.json(snapshot);
			if (url === '/admin/api/account-mcp') {
				return Response.json({
					...disabledAccount,
					mcp: { enabled: true, enabledAt: 2_000, updatedAt: 2_000 }
				});
			}
			if (url === '/admin/api/account' && init?.method === 'PUT') {
				return Response.json({
					...disabledAccount,
					usage: { ...disabledAccount.usage, maxBytes: 250_000_000, overridden: true }
				});
			}
			return Response.json(disabledAccount);
		});
		vi.stubGlobal('fetch', fetchMock);

		render(AdminPage);
		await screen.findByText('Sync accounts');
		expect(screen.getByText('3', { selector: '.metric strong' })).toBeTruthy();
		expect(screen.getByText('hosted MCP')).toBeTruthy();

		await fireEvent.input(screen.getByLabelText('Sync account ID'), {
			target: { value: 'account-123456789' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
		await screen.findByText('The account cannot issue or use hosted MCP credentials.');

		await fireEvent.input(screen.getByRole('spinbutton'), { target: { value: '250' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('250')
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Enable MCP' }));
		await screen.findByText('Hosted MCP enabled for this account.');
		expect(fetchMock).toHaveBeenCalledWith(
			'/admin/api/account-mcp',
			expect.objectContaining({ method: 'PUT' })
		);
	});
});
