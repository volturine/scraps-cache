<script lang="ts">
	import { portalToAppOverlay } from '$lib/appViewport';

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

	/** iOS pans the page to the focused field. Take focus ourselves so it does not. */
	function focusWithoutPan(event: PointerEvent) {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement) || input.disabled) return;
		if (document.activeElement === input) return;
		event.preventDefault();
		input.focus({ preventScroll: true });
		const end = input.value.length;
		input.setSelectionRange(end, end);
	}
</script>

<svelte:window onkeydown={keydown} />

<div
	{@attach portalToAppOverlay}
	class="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pb-4 pt-[calc(var(--app-topbar-height)+0.5rem)]"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget && !busy) onClose();
	}}
>
	<div
		class="scraps-cache-dialog w-full max-w-sm"
		role="dialog"
		aria-modal="true"
		aria-labelledby="backup-dialog-title"
	>
		<div class="border-b border-[var(--scraps-cache-border)] px-5 py-4">
			<p
				class="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--scraps-cache-text-muted)]"
			>
				Encrypted on this device
			</p>
			<h2 id="backup-dialog-title" class="text-lg font-semibold text-[var(--scraps-cache-text)]">
				{exporting ? 'Protect this backup' : 'Unlock this backup'}
			</h2>
			<p class="mt-1 text-sm leading-relaxed text-[var(--scraps-cache-text-muted)]">
				{exporting
					? 'Scraps Cache cannot recover this passphrase. Store it separately from the backup file.'
					: 'The passphrase and decrypted notes stay in this browser.'}
			</p>
		</div>

		<form class="space-y-4 px-5 py-5" onsubmit={submit}>
			<label class="block">
				<span class="mb-1.5 block text-xs font-medium text-[var(--scraps-cache-text-muted)]"
					>Backup passphrase</span
				>
				<input
					type="password"
					autocomplete={exporting ? 'new-password' : 'current-password'}
					bind:value={passphrase}
					disabled={busy}
					onpointerdown={focusWithoutPan}
					class="scraps-cache-input w-full bg-transparent px-3 py-2.5 text-[16px]"
				/>
			</label>

			{#if exporting}
				<label class="block">
					<span class="mb-1.5 block text-xs font-medium text-[var(--scraps-cache-text-muted)]"
						>Confirm passphrase</span
					>
					<input
						type="password"
						autocomplete="new-password"
						bind:value={confirmation}
						disabled={busy}
						onpointerdown={focusWithoutPan}
						class="scraps-cache-input w-full bg-transparent px-3 py-2.5 text-[16px]"
					/>
				</label>
			{/if}

			{#if localError || error}
				<p class="text-sm text-[var(--scraps-cache-danger)]" role="alert">{localError || error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onclick={onClose}
					disabled={busy}
					class="scraps-cache-button scraps-cache-button-quiet px-3 py-2 text-sm">Cancel</button
				>
				<button
					type="submit"
					disabled={busy}
					class="scraps-cache-button scraps-cache-button-primary px-4 py-2 text-sm font-medium"
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
