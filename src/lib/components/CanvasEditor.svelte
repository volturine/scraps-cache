<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Check, Highlighter, LoaderCircle, PenLine, Pencil, X } from '@lucide/svelte';
	import {
		createCanvasAttachment,
		decodeCanvasAttachment,
		type CanvasScene
	} from '$lib/canvasAttachment';
	import type { DrawingPreset, ExcalidrawHost } from '$lib/excalidrawHost';
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

	function setPreset(preset: DrawingPreset) {
		host?.setDrawingPreset(preset);
		if (host && !readOnly) dirty = true;
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
	class="canvas-editor-shell fixed z-[90] flex flex-col bg-[#f7f6f2] text-slate-900 dark:bg-[#171918] dark:text-slate-100"
	role="dialog"
	tabindex="-1"
	aria-modal="true"
	aria-label={readOnly ? 'View canvas' : attachment ? 'Edit canvas' : 'New canvas'}
>
	<header
		class="relative z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-black/10 bg-white/95 p-2 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#202221]/95 sm:flex-nowrap sm:px-3"
	>
		<button
			type="button"
			class="icon-btn h-10 w-10 shrink-0 p-2 touch-manipulation"
			onclick={close}
			aria-label={readOnly ? 'Close canvas' : 'Cancel canvas editing'}
		>
			<X class="h-5 w-5" aria-hidden="true" />
		</button>
		<div class="min-w-0 flex-1 pr-1 sm:flex-none sm:shrink-0">
			<div class="truncate text-sm font-semibold">{attachment?.name ?? 'Canvas'}</div>
			<div
				class="hidden text-[10px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400 sm:block"
			>
				{readOnly ? 'View' : 'Infinite drawing'}
			</div>
		</div>

		{#if !readOnly}
			<div
				class="scrollable order-3 flex w-full min-w-0 items-center gap-1 overflow-x-auto rounded-xl bg-black/5 p-1 dark:bg-white/10 sm:order-none sm:mx-auto sm:w-auto"
				aria-label="Freehand tools"
			>
				<button
					type="button"
					class="canvas-preset"
					onclick={() => setPreset('pencil')}
					title="Pencil"
					aria-label="Pencil"
					><Pencil class="h-4 w-4" aria-hidden="true" /><span>Pencil</span></button
				>
				<button
					type="button"
					class="canvas-preset"
					onclick={() => setPreset('pen')}
					title="Pen"
					aria-label="Pen"><PenLine class="h-4 w-4" aria-hidden="true" /><span>Pen</span></button
				>
				<button
					type="button"
					class="canvas-preset"
					onclick={() => setPreset('marker')}
					title="Marker"
					aria-label="Marker"
					><PenLine class="h-5 w-5" strokeWidth={3} aria-hidden="true" /><span>Marker</span></button
				>
				<button
					type="button"
					class="canvas-preset"
					onclick={() => setPreset('highlighter')}
					title="Highlighter"
					aria-label="Highlighter"
					><Highlighter class="h-4 w-4" aria-hidden="true" /><span>Highlight</span></button
				>
			</div>

			<button
				type="button"
				class="scrapscache-button scrapscache-button-primary order-2 ml-auto min-w-[5.25rem] shrink-0 px-3 py-2 text-sm sm:order-none"
				disabled={loading || saving}
				onclick={() => void save()}
			>
				{#if saving}
					<LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
				{:else}
					<Check class="h-4 w-4" aria-hidden="true" />
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
			<div class="absolute inset-0 z-20 grid place-items-center bg-[#f7f6f2] dark:bg-[#171918]">
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
		top: calc(var(--app-inset-top) + var(--app-visual-offset-top));
		right: var(--app-inset-right);
		bottom: var(--app-inset-bottom);
		left: var(--app-inset-left);
	}

	.canvas-preset {
		display: inline-flex;
		min-height: 2.25rem;
		align-items: center;
		gap: 0.35rem;
		border-radius: 0.55rem;
		padding: 0.4rem 0.55rem;
		font-size: 0.72rem;
		font-weight: 600;
		white-space: nowrap;
		touch-action: manipulation;
	}

	.canvas-preset:hover,
	.canvas-preset:focus-visible {
		background: color-mix(in srgb, currentColor 10%, transparent);
		outline: none;
	}

	:global(.scrapscache-canvas label[title='Library']) {
		display: none !important;
	}

	@media (max-width: 520px) {
		.canvas-preset span {
			display: none;
		}
		.canvas-preset {
			padding-inline: 0.55rem;
		}
	}
</style>
