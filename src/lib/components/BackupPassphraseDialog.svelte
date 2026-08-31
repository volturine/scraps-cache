<script lang="ts">
	import { portalToAppOverlay } from '$lib/appViewport';
	import { BackupOperation } from '$lib/backup';
	import { onMount } from 'svelte';

	let {
		mode,
		busy = false,
		error = '',
		onSubmit,
		onClose
	}: {
		mode: BackupOperation;
		busy?: boolean;
		error?: string;
		onSubmit: (passphrase: string) => void | Promise<void>;
		onClose: () => void;
	} = $props();

	let passphrase = $state('');
	let confirmation = $state('');
	let localError = $state('');
	let dialogElement: HTMLDivElement | null = $state(null);
	let passphraseInput: HTMLInputElement | null = $state(null);
	const exporting = $derived(mode === BackupOperation.Export);

	onMount(() => {
		passphraseInput?.focus({ preventScroll: true });
	});

	function trapFocus(event: KeyboardEvent) {
		if (event.key !== 'Tab' || !dialogElement) return;
		const focusables = dialogElement.querySelectorAll<HTMLElement>(
			'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (event.shiftKey) {
			if (active === first || !dialogElement.contains(active)) {
				event.preventDefault();
				last.focus();
			}
		} else if (active === last || !dialogElement.contains(active)) {
			event.preventDefault();
			first.focus();
		}
	}

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
	{@attach portalToAppOverlay}
	class="absolute inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pb-4 pt-[calc(var(--app-topbar-height)+0.5rem)]"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget && !busy) onClose();
	}}
>
	<div
		class="scrapscache-dialog w-full max-w-sm"
		bind:this={dialogElement}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="backup-dialog-title"
		onkeydown={trapFocus}
	>
		<div class="border-b border-[var(--scrapscache-border)] px-5 py-4">
			<p
				class="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--scrapscache-text-muted)]"
			>
				Encrypted on this device
			</p>
			<h2 id="backup-dialog-title" class="text-lg font-semibold text-[var(--scrapscache-text)]">
				{exporting ? 'Protect this backup' : 'Unlock this backup'}
			</h2>
			<p class="mt-1 text-sm leading-relaxed text-[var(--scrapscache-text-muted)]">
				{exporting
					? 'Scraps Cache cannot recover this passphrase. Store it separately from the backup file.'
					: 'The passphrase and decrypted notes stay in this browser.'}
			</p>
		</div>

		<form class="space-y-4 px-5 py-5" onsubmit={submit}>
			<label class="block">
				<span class="mb-1.5 block text-xs font-medium text-[var(--scrapscache-text-muted)]"
					>Backup passphrase</span
				>
				<input
					type="password"
					autocomplete={exporting ? 'new-password' : 'current-password'}
					bind:value={passphrase}
					bind:this={passphraseInput}
					disabled={busy}
					class="scrapscache-input w-full px-3 py-2.5 text-[16px]"
				/>
			</label>

			{#if exporting}
				<label class="block">
					<span class="mb-1.5 block text-xs font-medium text-[var(--scrapscache-text-muted)]"
						>Confirm passphrase</span
					>
					<input
						type="password"
						autocomplete="new-password"
						bind:value={confirmation}
						disabled={busy}
						class="scrapscache-input w-full px-3 py-2.5 text-[16px]"
					/>
				</label>
			{/if}

			{#if localError || error}
				<p class="text-sm text-[var(--scrapscache-danger)]" role="alert">{localError || error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onclick={onClose}
					disabled={busy}
					class="scrapscache-button scrapscache-button-quiet px-3 py-2 text-sm">Cancel</button
				>
				<button
					type="submit"
					disabled={busy}
					class="scrapscache-button scrapscache-button-primary px-4 py-2 text-sm font-medium"
					>{busy
						? exporting
							? 'Encrypting…'
							: 'Decrypting…'
						: exporting
							? 'Download backup'
							: 'Unlock backup'}</button
				>
			</div>
		</form>
	</div>
</div>
