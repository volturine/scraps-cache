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
		class="w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] shadow-2xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="backup-dialog-title"
	>
		<div class="border-b border-[var(--gkc-border)] px-5 py-4">
			<p
				class="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--gkc-text-muted)]"
			>
				Encrypted on this device
			</p>
			<h2 id="backup-dialog-title" class="text-lg font-semibold text-[var(--gkc-text)]">
				{exporting ? 'Protect this backup' : 'Unlock this backup'}
			</h2>
			<p class="mt-1 text-sm leading-relaxed text-[var(--gkc-text-muted)]">
				{exporting
					? 'Shard cannot recover this passphrase. Store it separately from the backup file.'
					: 'The passphrase and decrypted notes stay in this browser.'}
			</p>
		</div>

		<form class="space-y-4 px-5 py-5" onsubmit={submit}>
			<label class="block">
				<span class="mb-1.5 block text-xs font-medium text-[var(--gkc-text-muted)]"
					>Backup passphrase</span
				>
				<input
					type="password"
					autocomplete={exporting ? 'new-password' : 'current-password'}
					bind:value={passphrase}
					disabled={busy}
					class="w-full rounded-lg border border-[var(--gkc-border)] bg-transparent px-3 py-2.5 text-sm text-[var(--gkc-text)] outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
				/>
			</label>

			{#if exporting}
				<label class="block">
					<span class="mb-1.5 block text-xs font-medium text-[var(--gkc-text-muted)]"
						>Confirm passphrase</span
					>
					<input
						type="password"
						autocomplete="new-password"
						bind:value={confirmation}
						disabled={busy}
						class="w-full rounded-lg border border-[var(--gkc-border)] bg-transparent px-3 py-2.5 text-sm text-[var(--gkc-text)] outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
					/>
				</label>
			{/if}

			{#if localError || error}
				<p class="text-sm text-red-600" role="alert">{localError || error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onclick={onClose}
					disabled={busy}
					class="rounded-lg px-3 py-2 text-sm text-[var(--gkc-text-muted)] hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
					>Cancel</button
				>
				<button
					type="submit"
					disabled={busy}
					class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
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
