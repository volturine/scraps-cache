<script lang="ts">
	import type { NoteImage } from '$lib/types';
	import { dataUrlToBlob } from '$lib/imageBlob';
	import { ChevronLeft } from '@lucide/svelte';

	let {
		attachment = null,
		onClose
	}: {
		attachment?: NoteImage | null;
		onClose: () => void;
	} = $props();

	let sourceUrl = $state<string | null>(null);
	let textContent = $state<string | null>(null);
	let loading = $state(false);

	const mime = $derived(attachment?.mime || 'application/octet-stream');
	const isAudio = $derived(mime.startsWith('audio/'));
	const isVideo = $derived(mime.startsWith('video/'));
	const isText = $derived(
		mime.startsWith('text/') ||
			mime === 'application/json' ||
			mime === 'application/yaml' ||
			mime === 'application/x-yaml'
	);
	const isPdf = $derived(mime === 'application/pdf');

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
	}

	$effect(() => {
		const dataUrl = attachment?.dataUrl;
		const textFile = isText;
		if (!dataUrl) {
			sourceUrl = null;
			textContent = null;
			loading = false;
			return;
		}

		let current = true;
		let url: string | null = null;
		loading = true;
		sourceUrl = null;
		textContent = null;
		void dataUrlToBlob(dataUrl)
			.then(async (blob) => {
				if (textFile) {
					const text = await blob.text();
					if (current) textContent = text;
				} else if (current) {
					url = URL.createObjectURL(blob);
					sourceUrl = url;
				}
			})
			.catch(() => {
				if (current) textContent = 'Could not open this attachment.';
			})
			.finally(() => {
				if (current) loading = false;
			});

		return () => {
			current = false;
			if (url) URL.revokeObjectURL(url);
		};
	});

	function close() {
		onClose();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if attachment}
	<div {@attach portal}>
		<div class="fixed inset-0 z-[80] flex flex-col bg-[var(--gkc-bg)] text-[var(--gkc-text)]">
			<header
				class="flex shrink-0 items-center gap-3 border-b border-[var(--gkc-border)] px-3 py-2"
			>
				<button
					type="button"
					class="icon-btn h-10 w-10 p-2"
					onclick={close}
					aria-label="Close file"
				>
					<ChevronLeft class="h-6 w-6" aria-hidden="true" />
				</button>
				<div class="min-w-0 flex-1 truncate text-sm font-medium">
					{attachment.name || 'Attachment'}
				</div>
			</header>

			{#if loading}
				<div class="grid flex-1 place-items-center text-sm text-[var(--gkc-text-muted)]">
					Opening file…
				</div>
			{:else if isText}
				<pre
					class="scrollable m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm leading-relaxed text-[var(--gkc-text)]">{textContent ??
						''}</pre>
			{:else if isAudio && sourceUrl}
				<div class="grid flex-1 place-items-center p-6">
					<audio class="w-full max-w-lg" controls src={sourceUrl}></audio>
				</div>
			{:else if isVideo && sourceUrl}
				<!-- svelte-ignore a11y_media_has_caption -->
				<div class="flex flex-1 items-center justify-center bg-black">
					<video class="max-h-full max-w-full" controls playsinline src={sourceUrl}></video>
				</div>
			{:else if isPdf && sourceUrl}
				<iframe
					class="h-full w-full flex-1 border-0 bg-white"
					title={attachment.name || 'Attachment'}
					src={sourceUrl}
				></iframe>
			{/if}
		</div>
	</div>
{/if}
