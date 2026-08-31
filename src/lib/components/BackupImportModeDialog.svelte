<script lang="ts">
	import { portalToAppOverlay } from '$lib/appViewport';
	import { BackupImportMode } from '$lib/backup';
	import { onMount } from 'svelte';

	let {
		busy = false,
		error = '',
		onSelect,
		onClose
	}: {
		busy?: boolean;
		error?: string;
		onSelect: (mode: BackupImportMode) => void | Promise<void>;
		onClose: () => void;
	} = $props();

	let dialogElement: HTMLDivElement | null = $state(null);
	let keepButton: HTMLButtonElement | null = $state(null);

	onMount(() => keepButton?.focus({ preventScroll: true }));

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !busy) onClose();
	}

	function trapFocus(event: KeyboardEvent) {
		if (event.key !== 'Tab' || !dialogElement) return;
		const focusables = dialogElement.querySelectorAll<HTMLElement>('button:not([disabled])');
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialogElement.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !dialogElement.contains(active))) {
			event.preventDefault();
			first.focus();
		}
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
		aria-labelledby="backup-import-mode-title"
		onkeydown={trapFocus}
	>
		<div class="border-b border-[var(--scrapscache-border)] px-5 py-4">
			<h2
				id="backup-import-mode-title"
				class="text-lg font-semibold text-[var(--scrapscache-text)]"
			>
				How should this backup be imported?
			</h2>
		</div>

		<div class="space-y-3 px-5 py-5">
			<button
				bind:this={keepButton}
				type="button"
				disabled={busy}
				onclick={() => onSelect(BackupImportMode.Keep)}
				class="scrapscache-button w-full px-4 py-3 text-left"
			>
				<span class="block font-medium">Keep local notes</span>
				<span class="mt-1 block text-xs text-[var(--scrapscache-text-muted)]">
					Add every backup note as a new copy. Existing notes stay unchanged.
				</span>
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => onSelect(BackupImportMode.Replace)}
				class="scrapscache-button w-full px-4 py-3 text-left"
			>
				<span class="block font-medium text-[var(--scrapscache-danger)]">Replace local data</span>
				<span class="mt-1 block text-xs text-[var(--scrapscache-text-muted)]">
					Delete current local notes and restore the backup instead.
				</span>
			</button>
			{#if error}<p class="text-sm text-[var(--scrapscache-danger)]" role="alert">{error}</p>{/if}
			<div class="flex justify-end pt-1">
				<button
					type="button"
					disabled={busy}
					onclick={onClose}
					class="scrapscache-button scrapscache-button-quiet px-3 py-2 text-sm">Cancel</button
				>
			</div>
		</div>
	</div>
</div>
