// Profile switching orchestration. A switch is a dataset handover between two
// saved sync keys: the outgoing dataset is stashed, the incoming one (if this
// device has it) is reinstated, then the account is activated and the app
// pulls that key's cloud deltas. Runs under the sync web lock so no sync
// flight can interleave with the storage swap.
import { syncStore } from './sync.svelte';
import { notesStore, SYNC_LOCK } from './notes.svelte';
import {
	dropStashedDataset,
	nextProfileName,
	profileForSyncKey,
	resetDeviceDataset,
	restoreProfileDataset,
	stashProfileDataset,
	type StoredProfile
} from '$lib/profiles';
import { randomOpaqueId } from '$lib/syncPairing';

export class ProfileCoordinator {
	/** True while a create/switch/adopt handover is in progress. */
	switching = $state(false);

	private async exclusive<T>(run: () => Promise<T>): Promise<T> {
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		if (!locks?.request) return run();
		return locks.request(SYNC_LOCK, run);
	}

	private guard(blockOnSync = true): string | null {
		if (this.switching) return 'Another profile change is still running';
		// A running sync must finish before its dataset can be stashed; the web
		// lock below is only a safety net against races, not a waiting room.
		// Pairing grants are exempt: they are one-time and expire in 60 seconds,
		// so waiting out the flight beats losing the key.
		if (blockOnSync && notesStore.syncing)
			return 'Sync is still running. Try again when it finishes.';
		return null;
	}

	/** Create a brand-new sync key and make it the active profile. */
	async create(name?: string): Promise<{ success: boolean; error?: string }> {
		const blocked = this.guard();
		if (blocked) return { success: false, error: blocked };
		this.switching = true;
		try {
			return await this.exclusive(async () => {
				await syncStore.waitForOutboxWrites();
				const result = await syncStore.register(name);
				if (!result.success || !result.profile)
					return { success: false, error: result.error ?? 'Registration failed' };
				// First-ever registration keeps the current local notes (they upload
				// with the empty baseline); adding a key parks them with its profile.
				const previous = syncStore.activeProfile;
				if (previous) {
					await stashProfileDataset(previous.id);
					await resetDeviceDataset();
				}
				syncStore.activateProfile(result.profile);
				if (previous) await notesStore.adoptDeviceDataset(null);
				void notesStore.syncWithCloudManual();
				return { success: true };
			});
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : 'Could not switch profiles'
			};
		} finally {
			this.switching = false;
		}
	}

	/** Swap the live dataset for another saved sync key's. */
	async switchTo(profileId: string): Promise<{ success: boolean; error?: string }> {
		const blocked = this.guard();
		if (blocked) return { success: false, error: blocked };
		this.switching = true;
		try {
			return await this.exclusive(async () => {
				const target = syncStore.profiles.find((profile) => profile.id === profileId);
				if (!target) return { success: false, error: 'That sync key is no longer on this device' };
				if (target.id === syncStore.activeProfile?.id) return { success: true };
				await syncStore.waitForOutboxWrites();
				if (syncStore.activeProfile) await stashProfileDataset(syncStore.activeProfile.id);
				const extras = await restoreProfileDataset(target.id);
				if (!extras) await resetDeviceDataset();
				syncStore.activateProfile(target);
				await notesStore.adoptDeviceDataset(extras);
				await dropStashedDataset(target.id);
				void notesStore.syncWithCloudManual();
				return { success: true };
			});
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : 'Could not switch profiles'
			};
		} finally {
			this.switching = false;
		}
	}

	/**
	 * Activate a sync key received via device pairing.
	 * Returns 'choice' when this is the first key on the device so the modal
	 * can ask whether to merge or discard local notes; otherwise the previous
	 * profile's dataset is stashed and the paired key's cloud data is pulled.
	 */
	async receiveLinkedKey(
		syncKey: string
	): Promise<{ outcome: 'choice' | 'linked'; error?: string }> {
		const blocked = this.guard(false);
		if (blocked) return { outcome: 'choice', error: blocked };
		this.switching = true;
		try {
			return await this.exclusive(async () => {
				await syncStore.waitForOutboxWrites();
				let profile = profileForSyncKey(syncStore.profiles, syncKey);
				if (!profile) {
					profile = {
						id: randomOpaqueId(),
						name: nextProfileName(syncStore.profiles),
						syncKey,
						createdAt: Date.now()
					};
					await syncStore.addKeyringEntry(profile);
				}
				if (!syncStore.activeProfile || syncStore.activeProfile.id === profile.id) {
					syncStore.activateProfile(profile);
					return { outcome: 'choice' };
				}
				await stashProfileDataset(syncStore.activeProfile.id);
				const extras = await restoreProfileDataset(profile.id);
				if (!extras) await resetDeviceDataset();
				syncStore.activateProfile(profile);
				await notesStore.adoptDeviceDataset(extras);
				await dropStashedDataset(profile.id);
				void notesStore.replaceWithCloudManual();
				return { outcome: 'linked' };
			});
		} catch (err) {
			return {
				outcome: 'choice',
				error: err instanceof Error ? err.message : 'Could not set up the received sync key'
			};
		} finally {
			this.switching = false;
		}
	}
}

export const profileCoordinator = new ProfileCoordinator();
