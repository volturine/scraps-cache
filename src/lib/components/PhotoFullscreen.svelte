<script lang="ts">
	import type { NoteImage } from '$lib/types';
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';

	let {
		images,
		activeIndex = $bindable<number | null>(null)
	}: {
		images: NoteImage[];
		activeIndex?: number | null;
	} = $props();

	let touchStartX = 0;
	let controlsVisible = $state(false);
	let controlsTimer: ReturnType<typeof setTimeout> | null = null;

	function revealControls() {
		controlsVisible = true;
		if (controlsTimer) clearTimeout(controlsTimer);
		controlsTimer = setTimeout(() => {
			controlsVisible = false;
			controlsTimer = null;
		}, 1800);
	}

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
	}

	function close() {
		if (controlsTimer) clearTimeout(controlsTimer);
		controlsTimer = null;
		controlsVisible = false;
		activeIndex = null;
	}

	function move(offset: number) {
		if (activeIndex === null || images.length < 2) return;
		activeIndex = (activeIndex + offset + images.length) % images.length;
	}

	function previous() {
		move(-1);
		revealControls();
	}

	function next() {
		move(1);
		revealControls();
	}

	function handleKey(event: KeyboardEvent) {
		if (event.key === 'Escape') close();
		if (event.key === 'ArrowLeft') previous();
		if (event.key === 'ArrowRight') next();
	}

	function onTouchStart(event: TouchEvent) {
		revealControls();
		touchStartX = event.touches[0]?.clientX ?? 0;
	}

	function onTouchEnd(event: TouchEvent) {
		if (activeIndex === null || images.length < 2) return;
		const deltaX = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
		if (Math.abs(deltaX) < 48) return;
		move(deltaX < 0 ? 1 : -1);
	}
</script>

<svelte:window onkeydown={handleKey} />

{#if activeIndex !== null && images[activeIndex]}
	<div {@attach portal}>
		<button
			type="button"
			class="fixed inset-0 z-[80] cursor-zoom-out bg-black"
			onclick={close}
			aria-label="Close photo"
		></button>
		<button
			type="button"
			class="pointer-events-none fixed inset-0 z-[81] flex items-center justify-center"
			ontouchstart={onTouchStart}
			ontouchend={onTouchEnd}
			onclick={revealControls}
			aria-label="Show photo controls"
		>
			<img
				src={images[activeIndex].dataUrl}
				alt={images[activeIndex].name ?? 'Photo'}
				class="pointer-events-auto max-h-[100dvh] max-w-full select-none object-contain"
				decoding="async"
				draggable="false"
			/>
		</button>
		{#if controlsVisible}
			<button
				type="button"
				class="fixed right-4 top-[max(1rem,env(safe-area-inset-top))] z-[90] grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm touch-manipulation"
				onclick={close}
				aria-label="Close photo"
			>
				<X class="h-5 w-5" aria-hidden="true" />
			</button>
			{#if images.length > 1}
				<button
					type="button"
					class="fixed left-3 top-1/2 z-[90] grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm touch-manipulation"
					onclick={previous}
					aria-label="Previous photo"
				>
					<ChevronLeft class="h-5 w-5" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="fixed right-3 top-1/2 z-[90] grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm touch-manipulation"
					onclick={next}
					aria-label="Next photo"
				>
					<ChevronRight class="h-5 w-5" aria-hidden="true" />
				</button>
			{/if}
		{/if}
	</div>
{/if}
