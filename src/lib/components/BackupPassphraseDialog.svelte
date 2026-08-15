<script lang="ts">
	import { portalToAppFloat } from '$lib/appViewport';

	let {
		mode,
		busy = false,
		error = '',
		onSubmit,
		onClose
	}: {
		mode: 'export' | 'import';
		busy?: boolean;
		error?: string;
		onSubmit: (passphrase: string) => void | Promise<void>;
		onClose: () => void;
	} = $props();

	let passphrase = $state('');
	let confirmation = $state('');
	let localError = $state('');
	const exporting = $derived(mode === 'export');

	function submit(event: SubmitEvent) {
		event.preventDefault();
		localError = '';
		if (passphrase.length < 12) {
			localError = 'Use at least 12 characters.';
			return;
		}
		if (exporting && passphrase !== confirmation) {
			localError = 'The passphrases do not match.';
			return;
		}
		void onSubmit(passphrase);
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !busy) onClose();
	}
</script>

<svelte:window onkeydown={keydown} />

<div
	{@attach portalToAppFloat}
	class="fixed inset-0 z-[70] grid place-items-center bg-black/45 p-4"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget && !busy) onClose();
	}}
>
	<div
		class="shard-dialog w-full max-w-sm overflow-hidden"
		role="dialog"
		aria-modal="true"
		aria-labelledby="backup-dialog-title"
	>
		<div class="border-b border-[var(--shard-border)] px-5 py-4">
			<p
				class="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--shard-text-muted)]"
			>
				Encrypted on this device
			</p>
			<h2 id="backup-dialog-title" class="text-lg font-semibold text-[var(--shard-text)]">
				{exporting ? 'Protect this backup' : 'Unlock this backup'}
			</h2>
			<p class="mt-1 text-sm leading-relaxed text-[var(--shard-text-muted)]">
				{exporting
					? 'Shard cannot recover this passphrase. Store it separately from the backup file.'
					: 'The passphrase and decrypted notes stay in this browser.'}
			</p>
		</div>

		<form class="space-y-4 px-5 py-5" onsubmit={submit}>
			<label class="block">
				<span class="mb-1.5 block text-xs font-medium text-[var(--shard-text-muted)]"
					>Backup passphrase</span
				>
				<input
					type="password"
					autocomplete={exporting ? 'new-password' : 'current-password'}
					bind:value={passphrase}
					disabled={busy}
					class="shard-input w-full bg-transparent px-3 py-2.5 text-sm"
				/>
			</label>

			{#if exporting}
				<label class="block">
					<span class="mb-1.5 block text-xs font-medium text-[var(--shard-text-muted)]"
						>Confirm passphrase</span
					>
					<input
						type="password"
						autocomplete="new-password"
						bind:value={confirmation}
						disabled={busy}
						class="shard-input w-full bg-transparent px-3 py-2.5 text-sm"
					/>
				</label>
			{/if}

			{#if localError || error}
				<p class="text-sm text-[var(--shard-danger)]" role="alert">{localError || error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onclick={onClose}
					disabled={busy}
					class="shard-button shard-button-quiet px-3 py-2 text-sm">Cancel</button
				>
				<button
					type="submit"
					disabled={busy}
					class="shard-button shard-button-primary px-4 py-2 text-sm font-medium"
					>{busy
						? exporting
							? 'Encrypting…'
							: 'Decrypting…'
						: exporting
							? 'Download backup'
							: 'Restore backup'}</button
				>
			</div>
		</form>
	</div>
</div>
