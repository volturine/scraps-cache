<script lang="ts" generics="T extends string | number">
	const ITEM_H = 36;
	const VISIBLE = 5;

	let {
		items,
		value,
		onChange,
		ariaLabel,
		class: className = ''
	}: {
		items: { value: T; label: string }[];
		value: T;
		onChange: (value: T) => void;
		ariaLabel: string;
		class?: string;
	} = $props();

	const uid = $props.id();

	let el = $state<HTMLDivElement | undefined>();
	let scrollIndex = $state<number | null>(null);
	let dragging = false;
	let pointerStartY = 0;
	let ignoreScroll = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	function indexOf(next: T): number {
		const i = items.findIndex((item) => item.value === next);
		return i < 0 ? 0 : i;
	}

	const valueIndex = $derived(indexOf(value));
	const centerIndex = $derived(scrollIndex ?? valueIndex);

	function optionId(i: number): string {
		return `${uid}-opt-${i}`;
	}

	function snapTo(index: number) {
		if (!el) return;
		const top = index * ITEM_H;
		if (Math.abs(el.scrollTop - top) < 1) return;
		ignoreScroll = true;
		el.scrollTop = top;
		requestAnimationFrame(() => {
			ignoreScroll = false;
		});
	}

	function commitIndex(index: number) {
		const clamped = Math.max(0, Math.min(items.length - 1, index));
		const next = items[clamped];
		if (!next) return;
		snapTo(clamped);
		if (next.value !== value) onChange(next.value);
		scrollIndex = null;
	}

	function settle() {
		if (ignoreScroll || !el) return;
		commitIndex(Math.round(el.scrollTop / ITEM_H));
	}

	function scheduleSettle() {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(settle, 120);
	}

	function handleScroll() {
		if (!el || ignoreScroll) return;
		scrollIndex = Math.round(el.scrollTop / ITEM_H);
		scheduleSettle();
	}

	function attachWheel(node: HTMLDivElement) {
		el = node;
		const onScroll = () => handleScroll();
		const onEnd = () => settle();
		node.addEventListener('scroll', onScroll);
		node.addEventListener('scrollend', onEnd);
		$effect(() => {
			snapTo(valueIndex);
		});
		return () => {
			node.removeEventListener('scroll', onScroll);
			node.removeEventListener('scrollend', onEnd);
			if (settleTimer) clearTimeout(settleTimer);
			el = undefined;
		};
	}

	function handleKeydown(e: KeyboardEvent) {
		const idx = indexOf(value);
		if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
			e.preventDefault();
			if (idx > 0) onChange(items[idx - 1].value);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
			e.preventDefault();
			if (idx < items.length - 1) onChange(items[idx + 1].value);
		} else if (e.key === 'Home') {
			e.preventDefault();
			onChange(items[0].value);
		} else if (e.key === 'End') {
			e.preventDefault();
			onChange(items[items.length - 1].value);
		} else if (e.key === 'PageUp') {
			e.preventDefault();
			onChange(items[Math.max(0, idx - 5)].value);
		} else if (e.key === 'PageDown') {
			e.preventDefault();
			onChange(items[Math.min(items.length - 1, idx + 5)].value);
		}
	}

	function handlePointerDown(e: PointerEvent) {
		pointerStartY = e.clientY;
		dragging = false;
	}

	function handlePointerMove(e: PointerEvent) {
		if (Math.abs(e.clientY - pointerStartY) > 6) dragging = true;
	}

	function selectItem(item: { value: T }) {
		if (dragging) return;
		onChange(item.value);
	}

	function handleOptionKeydown(e: KeyboardEvent, item: { value: T }) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			selectItem(item);
		}
	}
</script>

<div class="relative {className}" style="height: {ITEM_H * VISIBLE}px">
	<div
		class="pointer-events-none absolute inset-x-0 top-1/2 z-0 h-9 -translate-y-1/2 rounded-lg bg-[var(--gkc-bg)]"
		aria-hidden="true"
	></div>
	<div
		class="wheel-picker scrollable absolute inset-0 z-10 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
		style="height: {ITEM_H * VISIBLE}px"
		role="listbox"
		tabindex="0"
		aria-label={ariaLabel}
		aria-activedescendant={optionId(centerIndex)}
		{@attach attachWheel}
		onkeydown={handleKeydown}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
	>
		<div style="height: {ITEM_H * 2}px" aria-hidden="true"></div>
		{#each items as item, i (item.value)}
			<div
				id={optionId(i)}
				role="option"
				tabindex="-1"
				aria-selected={item.value === value}
				class="flex cursor-pointer items-center justify-center tabular-nums transition-opacity duration-75
					{i === centerIndex
					? 'text-base font-semibold text-[var(--gkc-text)]'
					: Math.abs(i - centerIndex) === 1
						? 'text-sm font-medium text-[var(--gkc-text-muted)]'
						: 'text-sm text-[var(--gkc-text-muted)] opacity-40'}"
				style="height: {ITEM_H}px; scroll-snap-align: center"
				onclick={() => selectItem(item)}
				onkeydown={(e) => handleOptionKeydown(e, item)}
			>
				{item.label}
			</div>
		{/each}
		<div style="height: {ITEM_H * 2}px" aria-hidden="true"></div>
	</div>
</div>

<style>
	.wheel-picker {
		scrollbar-width: none;
		-ms-overflow-style: none;
		scroll-snap-type: y mandatory;
		overscroll-behavior: contain;
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0%,
			#000 28%,
			#000 72%,
			transparent 100%
		);
		mask-image: linear-gradient(to bottom, transparent 0%, #000 28%, #000 72%, transparent 100%);
	}

	.wheel-picker::-webkit-scrollbar {
		display: none;
	}
</style>
