// Profile switching orchestration. Datasets are namespaced per profile, so a
// switch is: drain pending writes, flip this window's identity, reload memory
// from the target namespace, then pull that key's cloud deltas. Runs under the
// sync web lock so no sync flight can interleave with the handover.
import { syncStore, PROFILE_META_KEY } from './sync.svelte';
import { notesStore, SYNC_LOCK } from './notes.svelte';
import {
	adoptLocalDatasetInto,
	nextProfileName,
	profileForSyncKey,
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
		// A running sync must finish before its dataset can be handed over; the
		// web lock below is only a safety net against races, not a waiting room.
		if (blockOnSync && notesStore.syncing)
			return 'Sync is still running. Try again when it finishes.';
		return null;
	}

	private async activate(
		target: StoredProfile,
		options: { adoptLocal?: boolean } = {}
	): Promise<void> {
		if (options.adoptLocal && !syncStore.activeProfile) {
			await adoptLocalDatasetInto(target.id);
		}
		syncStore.activateProfile(target);
		await notesStore.reloadForProfile();
		// Queue the encrypted profile-name record so a fresh key's account learns
		// its local name (baseline dedupe makes repeat switches free).
		void syncStore.queueOutbox([PROFILE_META_KEY]).catch(() => undefined);
	}

	/** Create a brand-new sync key and make it this window's active profile. */
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
				// The very first key on a device adopts local no-account data so
				// registering never looks like data loss; later keys start empty.
				await this.activate(result.profile, { adoptLocal: !syncStore.activeProfile });
				await notesStore.syncWithCloudManual();
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

	/** Point this window at another saved sync key's namespace. */
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
				await this.activate(target);
				await notesStore.syncWithCloudManual();
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
	 * can ask whether to merge or discard local notes; otherwise the paired
	 * key's own namespace is activated and its cloud data is pulled.
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
				// A key this device already holds keeps its namespace and any offline
				// edits: pairing must never replace it from the relay. Only a brand
				// new key starts from an empty namespace.
				const existed = profile != null;
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
					// First key on this device: take ownership of any local no-account
					// data up front, then let the modal ask merge vs discard.
					if (!syncStore.activeProfile) await adoptLocalDatasetInto(profile.id);
					await this.activate(profile);
					return { outcome: 'choice' };
				}
				await this.activate(profile);
				if (existed) await notesStore.syncWithCloudManual();
				else await notesStore.replaceWithCloudManual();
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
