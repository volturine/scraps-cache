<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { LoaderCircle, X } from '@lucide/svelte';
	import {
		createCanvasAttachment,
		decodeCanvasAttachment,
		type CanvasScene
	} from '$lib/canvasAttachment';
	import type { ExcalidrawHost } from '$lib/excalidrawHost';
	import type { NoteImage } from '$lib/types';
	import { uiStore } from '$lib/stores/ui.svelte';

	let {
		attachment = null,
		readOnly = false,
		onSave,
		onClose
	}: {
		attachment?: NoteImage | null;
		readOnly?: boolean;
		onSave?: (attachment: NoteImage, sourceHash?: string) => void | Promise<void>;
		onClose: () => void;
	} = $props();

	let hostNode = $state<HTMLDivElement | null>(null);
	let host: ExcalidrawHost | null = null;
	let loading = $state(true);
	let saving = $state(false);
	let dirty = $state(false);
	let error = $state('');
	let sourceHash: string | undefined;

	onMount(() => {
		let cancelled = false;
		sourceHash = attachment?.contentHash;
		void (async () => {
			try {
				let initialScene: CanvasScene | undefined;
				if (attachment) initialScene = await decodeCanvasAttachment(attachment);
				if (cancelled || !hostNode) return;
				(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';
				const { mountExcalidraw } = await import('$lib/excalidrawHost');
				if (cancelled || !hostNode) return;
				const mounted = await mountExcalidraw(hostNode, {
					initialScene,
					dark: uiStore.effectiveDark,
					readOnly
				});
				if (cancelled) {
					mounted.destroy();
					return;
				}
				host = mounted;
			} catch (cause) {
				error = cause instanceof Error ? cause.message : 'Could not open this canvas.';
			} finally {
				if (!cancelled) loading = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => host?.destroy());

	function close() {
		if (saving) return;
		if (dirty && !confirm('Discard your unsaved canvas changes?')) return;
		onClose();
	}

	function markCanvasInteraction(event: Event) {
		if (readOnly) return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('.scrapscache-canvas')) dirty = true;
	}

	async function save() {
		if (!host || saving || readOnly) return;
		error = '';
		saving = true;
		try {
			const preview = await host.thumbnail();
			const saved = await createCanvasAttachment(
				host.snapshot(),
				preview.dataUrl,
				attachment ?? undefined
			);
			await onSave?.({ ...saved, width: preview.width, height: preview.height }, sourceHash);
			dirty = false;
			onClose();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save this canvas.';
		} finally {
			saving = false;
		}
	}

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}
</script>

<div
	use:portal
	onpointerdown={markCanvasInteraction}
	onkeydown={markCanvasInteraction}
	onwheel={markCanvasInteraction}
	class="canvas-editor-shell fixed z-[90] flex flex-col bg-white text-slate-900 dark:bg-[#121212] dark:text-slate-100"
	role="dialog"
	tabindex="-1"
	aria-modal="true"
	aria-label={readOnly ? 'View canvas' : attachment ? 'Edit canvas' : 'New canvas'}
>
	<header class="relative z-10 flex h-12 shrink-0 items-center justify-between px-3">
		<button
			type="button"
			class="canvas-header-action grid h-9 w-9 shrink-0 place-items-center rounded-full touch-manipulation"
			onclick={close}
			aria-label={readOnly ? 'Close canvas' : 'Cancel canvas editing'}
		>
			<X class="h-5.5 w-5.5" aria-hidden="true" />
		</button>

		{#if !readOnly}
			<button
				type="button"
				class="canvas-done h-9 shrink-0 rounded-full px-4 text-sm font-semibold touch-manipulation"
				disabled={loading || saving}
				onclick={() => void save()}
			>
				{#if saving}
					<LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
				{/if}
				<span>{saving ? 'Saving' : 'Done'}</span>
			</button>
		{/if}
	</header>

	{#if error}
		<div
			class="relative z-10 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
		>
			{error}
		</div>
	{/if}

	<div class="relative min-h-0 flex-1">
		<div bind:this={hostNode} class="scrapscache-canvas absolute inset-0"></div>
		{#if loading}
			<div class="absolute inset-0 z-20 grid place-items-center bg-white dark:bg-[#121212]">
				<div class="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
					<LoaderCircle class="h-5 w-5 animate-spin" aria-hidden="true" />
					Loading canvas…
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.canvas-editor-shell {
		top: var(--app-visual-offset-top);
		right: 0;
		bottom: 0;
		left: 0;
		padding-top: var(--app-inset-top);
		padding-right: var(--app-inset-right);
		padding-left: var(--app-inset-left);
	}

	.canvas-header-action {
		color: color-mix(in srgb, currentColor 82%, transparent);
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.canvas-header-action:hover,
	.canvas-header-action:focus-visible {
		background: color-mix(in srgb, currentColor 10%, transparent);
		color: currentColor;
		outline: 2px solid var(--scrapscache-focus);
		outline-offset: 2px;
	}

	.canvas-done {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		background: var(--scrapscache-accent);
		color: var(--scrapscache-accent-foreground);
		transition:
			background-color 120ms ease,
			transform 120ms ease;
	}

	.canvas-done:hover:not(:disabled) {
		background: var(--scrapscache-accent-hover);
	}

	.canvas-done:active:not(:disabled) {
		transform: scale(0.97);
	}

	.canvas-done:focus-visible {
		outline: 2px solid var(--scrapscache-focus);
		outline-offset: 2px;
	}

	.canvas-done:disabled {
		opacity: 0.5;
	}

	:global(.scrapscache-canvas label[title='Library']) {
		display: none !important;
	}

	:global(.scrapscache-canvas .excalidraw) {
		--sat: 0px;
		--sar: 0px;
		--sab: var(--app-inset-bottom);
		--sal: 0px;
	}

	:global(.scrapscache-canvas .App-bottom-bar .App-toolbar-content) {
		padding: 4px 8px !important;
	}

	:global(.scrapscache-canvas .App-bottom-bar .dropdown-menu--mobile) {
		bottom: 47px !important;
	}

	:global(.excalidraw-modal-container) {
		top: calc(var(--app-visual-offset-top) + var(--app-inset-top)) !important;
		right: var(--app-inset-right) !important;
		bottom: var(--app-inset-bottom) !important;
		left: var(--app-inset-left) !important;
		height: auto !important;
	}

	:global(.excalidraw-modal-container .Modal__background) {
		top: calc(var(--app-visual-offset-top) + var(--app-inset-top)) !important;
		right: var(--app-inset-right) !important;
		bottom: var(--app-inset-bottom) !important;
		left: var(--app-inset-left) !important;
	}

	:global(.excalidraw-modal-container .confirm-dialog.Modal) {
		align-items: center;
		padding: 1rem;
	}

	:global(.excalidraw-modal-container .confirm-dialog.Dialog--fullscreen .Modal__content) {
		position: relative;
		inset: auto;
		max-width: 34rem;
		max-height: 100%;
	}
</style>
