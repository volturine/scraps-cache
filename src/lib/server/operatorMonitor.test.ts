import { describe, expect, it } from 'vitest';
import { buildOperatorSnapshot } from './operatorMonitor';

const emptyActivity = {
	syncRequests: 4,
	syncUploadEnvelopes: 2,
	syncDeleteSlots: 1,
	rateLimited: 0,
	sqliteBusy: 0,
	reminderWakesSent: 0,
	reminderWakesGone: 0,
	reminderWakesFailed: 0
};

describe('operator snapshot', () => {
	it('reports anonymous storage, activity windows, and retention eligibility', () => {
		const snapshot = buildOperatorSnapshot(
			{
				accounts: 3,
				envelopeCount: 10,
				ciphertextBytes: 2_000_000_000,
				activeByWindowDays: { '1': 1, '7': 2, '30': 3 },
				staleAccounts: 1
			},
			{ maxAccountBytes: 1_000_000_000, maxAccountEnvelopes: 50_000 },
			emptyActivity,
			{
				enabled: true,
				running: false,
				inactiveDays: 365,
				lastRunAt: 10,
				lastSuccessAt: 10,
				lastDeletedAccounts: 0,
				deletedAccountsTotal: 0,
				lastPurgedSlots: 0,
				failures: 0,
				lastError: null
			},
			{
				enabled: true,
				running: false,
				lastAttemptAt: 1,
				lastSuccessAt: 1,
				failures: 0,
				durationMs: 2,
				lastError: null,
				lastFile: null
			},
			1_000,
			365
		);

		expect(snapshot.storage).toEqual({
			ciphertextBytes: 2_000_000_000,
			gigabytes: 2,
			envelopes: 10
		});
		expect(snapshot.accounts).toEqual({
			total: 3,
			active: { '1': 1, '7': 2, '30': 3 },
			staleForRetention: 1
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/account-[a-z0-9]+|credential/i);
		expect(snapshot.activity.syncRequests).toBe(4);
	});

	it('omits stale retention counts when the policy is disabled', () => {
		const snapshot = buildOperatorSnapshot(
			{
				accounts: 1,
				envelopeCount: 0,
				ciphertextBytes: 0,
				activeByWindowDays: { '1': 1 },
				staleAccounts: 0
			},
			{ maxAccountBytes: 1, maxAccountEnvelopes: 1 },
			emptyActivity,
			{
				enabled: false,
				running: false,
				inactiveDays: 0,
				lastRunAt: 0,
				lastSuccessAt: 0,
				lastDeletedAccounts: 0,
				deletedAccountsTotal: 0,
				lastPurgedSlots: 0,
				failures: 0,
				lastError: null
			},
			{
				enabled: false,
				running: false,
				lastAttemptAt: 0,
				lastSuccessAt: 0,
				failures: 0,
				durationMs: 0,
				lastError: null,
				lastFile: null
			},
			1_000,
			0
		);
		expect(snapshot.accounts.staleForRetention).toBeNull();
	});
});
