<script lang="ts">
	import AttachmentFullscreen from '$lib/components/AttachmentFullscreen.svelte';
	import PhotoFullscreen from '$lib/components/PhotoFullscreen.svelte';
	import type { NoteImage } from '$lib/types';
	import {
		fileToNoteImage,
		isImageAttachment,
		isInlinePreviewable,
		fileIconLabel,
		formatBytes,
		dataUrlByteLength,
		openAttachment
	} from '$lib/noteImages';
	import { displayImageSrc } from '$lib/imageThumb';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { sha256 } from '$lib/syncHash';
	import { formatStorageError } from '$lib/imageBlob';

	let {
		images = $bindable<NoteImage[]>([]),
		body = $bindable(''),
		noteId = null as string | null,
		showCopy = false,
		showDelete = false,
		copyFlash = false,
		onOpenColor,
		onOpenTags,
		onCopy,
		onDelete,
		onImagesChange,
		onClose
	}: {
		images?: NoteImage[];
		body?: string;
		noteId?: string | null;
		showCopy?: boolean;
		showDelete?: boolean;
		copyFlash?: boolean;
		onOpenColor?: () => void;
		onOpenTags?: () => void;
		onCopy?: () => void;
		onDelete?: () => void;
		onImagesChange?: (images: NoteImage[]) => void;
		onClose?: () => void;
	} = $props();

	let focusedImageIndex = $state<number | null>(null);
	let focusedAttachment = $state<NoteImage | null>(null);
	let attachError = $state('');

	const imageAttachments = $derived(images.filter(isImageAttachment));
	const photos = $derived(imageAttachments.filter((attachment) => !!displayImageSrc(attachment)));
	const pendingPhotos = $derived(imageAttachments.filter((attachment) => !displayImageSrc(attachment)));
	const files = $derived(images.filter((a) => !isImageAttachment(a)));
	const photoIndexById = $derived(new Map(photos.map((p, i) => [p.id, i])));

	/**
	 * Normal button: each press creates a one-shot file input in this gesture,
	 * opens the system picker, then discards the input so cancel cannot stick.
	 */
	function openAttach() {
		attachError = '';
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		// Off-screen but not display:none (iOS blocks programmatic open on those).
		input.setAttribute('aria-hidden', 'true');
		Object.assign(input.style, {
			position: 'fixed',
			left: '0',
			top: '0',
			width: '1px',
			height: '1px',
			opacity: '0',
			pointerEvents: 'none',
			zIndex: '-1'
		});
		document.body.appendChild(input);

		let done = false;
		const openedAt = Date.now();
		const cleanup = () => {
			if (done) return;
			done = true;
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVis);
			queueMicrotask(() => {
				try {
					input.remove();
				} catch {
					/* ignore */
				}
			});
		};

		// Ignore focus blips while the sheet is still opening.
		const onFocus = () => {
			if (Date.now() - openedAt < 400) return;
			cleanup();
		};
		const onVis = () => {
			if (document.visibilityState !== 'visible') return;
			if (Date.now() - openedAt < 400) return;
			cleanup();
		};

		input.addEventListener(
			'change',
			() => {
				const picked = Array.from(input.files ?? []);
				cleanup();
				if (picked.length > 0) void addFiles(picked);
			},
			{ once: true }
		);

		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVis);

		input.click();
	}

	async function addFiles(picked: File[]) {
		attachError = '';
		try {
			const added = await Promise.all(picked.map(fileToNoteImage));
			const knownHashes = new Set(await Promise.all(
				images.map((image) => image.contentHash || sha256(image.dataUrl))
			));
			const unique: NoteImage[] = [];
			for (const att of added) {
				const hash = att.contentHash || await sha256(att.dataUrl);
				if (knownHashes.has(hash)) continue;
				knownHashes.add(hash);
				unique.push(att);
			}
			if (unique.length === 0) return;
			const next = [...images, ...unique];
			images = next;
			onImagesChange?.(next);
			if (noteId) {
				try {
					await notesStore.flushNote(noteId, { images: next });
				} catch (err) {
					console.error('[footer] attachment flush:', err);
					attachError = `Could not save attachment: ${formatStorageError(err)}`;
				}
			}
		} catch (err) {
			attachError = err instanceof Error ? err.message : 'Could not add file';
		}
	}

	function removeAttachment(id: string) {
		const next = images.filter((i) => i.id !== id);
		images = next;
		onImagesChange?.(next);
		if (noteId) {
			notesStore.flushNote(noteId, { images: next }).catch((err) => {
				console.error('[footer] remove attachment flush:', err);
			});
		}
	}

	function openTags(e: MouseEvent) {
		e.stopPropagation();
		if (!noteId) {
			attachError = 'Save the note first to add tags';
			return;
		}
		onOpenTags?.();
	}

	function openPhoto(id: string) {
		const idx = photoIndexById.get(id);
		if (idx != null) focusedImageIndex = idx;
	}
</script>

{#if attachError}
	<p class="px-3 pb-1 text-xs text-red-600 dark:text-red-400">{attachError}</p>
{/if}

{#if photos.length > 0 || pendingPhotos.length > 0}
	<div class="scrollable grid max-h-44 grid-cols-3 gap-2 overflow-y-auto px-3 pb-2 sm:grid-cols-4">
		{#each photos as img (img.id)}
			<div class="relative">
				<button
					type="button"
					class="block aspect-square w-full overflow-hidden rounded-lg touch-manipulation"
					onclick={() => openPhoto(img.id)}
					aria-label={`Open ${img.name ?? 'photo'}`}
				>
					<img src={displayImageSrc(img)} alt={img.name ?? 'Photo'} class="h-full w-full object-cover" loading="lazy" decoding="async" />
				</button>
				<button
					type="button"
					class="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-xs text-white touch-manipulation"
					onclick={() => removeAttachment(img.id)}
					aria-label="Remove photo"
				>✕</button>
			</div>
		{/each}
		{#each pendingPhotos as img (img.id)}
			<div class="aspect-square animate-pulse rounded-lg bg-black/10 dark:bg-white/10" role="img" aria-label={`Loading ${img.name ?? 'photo'}`}></div>
		{/each}
	</div>
	<p class="px-3 pb-2 text-[10px] text-[var(--gkc-text-muted)]">
		Photos are privacy-optimized before saving; originals are not retained.
	</p>
{/if}

{#if files.length > 0}
	<ul class="scrollable max-h-36 space-y-1.5 overflow-y-auto px-3 pb-2">
		{#each files as file (file.id)}
			<li class="flex items-center gap-2 rounded-lg border border-black/10 bg-black/5 px-2 py-1.5 dark:border-white/10 dark:bg-white/5">
				<span
					class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-black/10 text-[10px] font-bold tracking-wide text-[var(--gkc-text)] dark:bg-white/10"
					aria-hidden="true"
				>{fileIconLabel(file.mime, file.name)}</span>
				<button
					type="button"
					class="min-w-0 flex-1 text-left touch-manipulation"
					onclick={() => {
						if (isInlinePreviewable(file)) focusedAttachment = file;
						else void openAttachment(file);
					}}
					aria-label={`Open ${file.name ?? 'file'}`}
				>
					<div class="truncate text-sm text-[var(--gkc-text)]">{file.name || 'Attachment'}</div>
					<div class="text-[10px] text-[var(--gkc-text-muted)]">{formatBytes(dataUrlByteLength(file.dataUrl))}</div>
				</button>
				<button
					type="button"
					class="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-[var(--gkc-text-muted)] touch-manipulation"
					onclick={() => removeAttachment(file.id)}
					aria-label="Remove file"
				>✕</button>
			</li>
		{/each}
	</ul>
{/if}

<PhotoFullscreen images={photos} bind:activeIndex={focusedImageIndex} />
<AttachmentFullscreen attachment={focusedAttachment} onClose={() => { focusedAttachment = null; }} />

<footer class="flex shrink-0 items-center justify-between gap-2 border-t border-black/5 px-3 py-2 dark:border-white/10">
	<div class="flex shrink-0 items-center gap-1">
		<button type="button" class="icon-btn h-10 w-10 p-2 touch-manipulation" title="Attach" onclick={openAttach} aria-label="Attach">
			<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
			</svg>
		</button>
		<button type="button" class="icon-btn h-10 w-10 p-2 touch-manipulation" title="Tags" onclick={openTags} aria-label="Tags">
			<svg viewBox="0 0 24 24" class="h-5 w-5 fill-current"><path d="M20 12l-8 8-9-9V4h7l10 10zM5 6.5C5 5.7 5.7 5 6.5 5S8 5.7 8 6.5 7.3 8 6.5 8 5 7.3 5 6.5z"/></svg>
		</button>
	</div>

	<div class="flex max-w-[calc(100%-5.5rem)] flex-wrap items-center justify-end gap-1">
		<button type="button" class="icon-btn h-10 w-10 p-2 touch-manipulation" title="Color" aria-label="Color" onclick={() => onOpenColor?.()}>
			<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.2-1-2.1-2.2-2.1h-1.5a1.8 1.8 0 0 0-1.7 2.4 1.8 1.8 0 0 1-1.7 2.4A9 9 0 0 1 12 3z"/><circle cx="7.5" cy="10" r=".75" class="fill-current"/><circle cx="10" cy="6.8" r=".75" class="fill-current"/><circle cx="14" cy="6.8" r=".75" class="fill-current"/></svg>
		</button>
		{#if showCopy}
			<button type="button" class="icon-btn h-10 w-10 p-2 touch-manipulation" title="Copy note" aria-label="Copy note" onclick={() => onCopy?.()}>
				{#if copyFlash}<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4L19 6" /></svg>{:else}<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="10" height="11" rx="1"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4"/></svg>{/if}
			</button>
		{/if}
		{#if showDelete}
			<button type="button" class="icon-btn h-10 w-10 p-2 text-red-600 touch-manipulation dark:text-red-400" title="Delete note" aria-label="Delete note" onclick={() => onDelete?.()}>
				<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m2 0v14H6V6m4 4v6m4-6v6" /></svg>
			</button>
		{/if}
		{#if onClose}
			<button type="button" class="icon-btn h-10 w-10 p-2 touch-manipulation" title="Done" aria-label="Done" onclick={() => onClose?.()}>
				<svg viewBox="0 0 24 24" class="h-5 w-5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4L19 6" /></svg>
			</button>
		{/if}
	</div>
</footer>
