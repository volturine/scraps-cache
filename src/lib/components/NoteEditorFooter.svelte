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
	import {
		Archive,
		Check,
		Copy,
		MoreHorizontal,
		Palette,
		Paperclip,
		Tag,
		Trash2,
		X
	} from '@lucide/svelte';

	let {
		images = $bindable<NoteImage[]>([]),
		body = $bindable(''),
		noteId = null as string | null,
		showCopy = false,
		showArchive = false,
		showDelete = false,
		archived = false,
		copyFlash = false,
		onOpenColor,
		onOpenTags,
		onCopy,
		onArchive,
		onDelete,
		onImagesChange,
		onClose
	}: {
		images?: NoteImage[];
		body?: string;
		noteId?: string | null;
		showCopy?: boolean;
		showArchive?: boolean;
		showDelete?: boolean;
		archived?: boolean;
		copyFlash?: boolean;
		onOpenColor?: () => void;
		onOpenTags?: () => void;
		onCopy?: () => void;
		onArchive?: () => void;
		onDelete?: () => void;
		onImagesChange?: (images: NoteImage[]) => void;
		onClose?: () => void;
	} = $props();

	let focusedImageIndex = $state<number | null>(null);
	let focusedAttachment = $state<NoteImage | null>(null);
	let attachError = $state('');
	let actionsOpen = $state(false);
	let actionsContainer = $state<HTMLElement | null>(null);

	const imageAttachments = $derived(images.filter(isImageAttachment));
	const photos = $derived(imageAttachments.filter((attachment) => !!displayImageSrc(attachment)));
	const pendingPhotos = $derived(
		imageAttachments.filter((attachment) => !displayImageSrc(attachment))
	);
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
			const knownHashes = new Set(
				await Promise.all(images.map((image) => image.contentHash || sha256(image.dataUrl)))
			);
			const unique: NoteImage[] = [];
			for (const att of added) {
				const hash = att.contentHash || (await sha256(att.dataUrl));
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
			attachError = 'Save the note first to add labels';
			return;
		}
		onOpenTags?.();
	}

	function openPhoto(id: string) {
		const idx = photoIndexById.get(id);
		if (idx != null) focusedImageIndex = idx;
	}

	function closeActionsOnOutsideClick(event: MouseEvent) {
		const target = event.target;
		if (actionsOpen && target instanceof Node && !actionsContainer?.contains(target))
			actionsOpen = false;
	}
</script>

<svelte:window onclick={closeActionsOnOutsideClick} />

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
					<img
						src={displayImageSrc(img)}
						alt={img.name ?? 'Photo'}
						class="h-full w-full object-cover"
						loading="lazy"
						decoding="async"
					/>
				</button>
				<button
					type="button"
					class="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-xs text-white touch-manipulation"
					onclick={() => removeAttachment(img.id)}
					aria-label="Remove photo"
				>
					<X class="h-3 w-3" aria-hidden="true" />
				</button>
			</div>
		{/each}
		{#each pendingPhotos as img (img.id)}
			<div
				class="aspect-square animate-pulse rounded-lg bg-black/10 dark:bg-white/10"
				role="img"
				aria-label={`Loading ${img.name ?? 'photo'}`}
			></div>
		{/each}
	</div>
	<p class="px-3 pb-2 text-[10px] text-[var(--shard-text-muted)]">
		Photos are privacy-optimized before saving; originals are not retained.
	</p>
{/if}

{#if files.length > 0}
	<ul class="scrollable max-h-36 space-y-1.5 overflow-y-auto px-3 pb-2">
		{#each files as file (file.id)}
			<li
				class="flex items-center gap-2 rounded-lg border border-black/10 bg-black/5 px-2 py-1.5 dark:border-white/10 dark:bg-white/5"
			>
				<span
					class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-black/10 text-[10px] font-bold tracking-wide text-[var(--shard-text)] dark:bg-white/10"
					aria-hidden="true">{fileIconLabel(file.mime, file.name)}</span
				>
				<button
					type="button"
					class="min-w-0 flex-1 text-left touch-manipulation"
					onclick={() => {
						if (isInlinePreviewable(file)) focusedAttachment = file;
						else void openAttachment(file);
					}}
					aria-label={`Open ${file.name ?? 'file'}`}
				>
					<div class="truncate text-sm text-[var(--shard-text)]">{file.name || 'Attachment'}</div>
					<div class="text-[10px] text-[var(--shard-text-muted)]">
						{formatBytes(dataUrlByteLength(file.dataUrl))}
					</div>
				</button>
				<button
					type="button"
					class="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-[var(--shard-text-muted)] touch-manipulation"
					onclick={() => removeAttachment(file.id)}
					aria-label="Remove file"
				>
					<X class="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			</li>
		{/each}
	</ul>
{/if}

<PhotoFullscreen images={photos} bind:activeIndex={focusedImageIndex} />
<AttachmentFullscreen
	attachment={focusedAttachment}
	onClose={() => {
		focusedAttachment = null;
	}}
/>

<footer
	class="flex shrink-0 items-center justify-between gap-2 border-t border-black/5 px-3 py-2 dark:border-white/10"
>
	<div class="flex shrink-0 items-center gap-1">
		<button
			type="button"
			class="icon-btn h-10 w-10 p-2 touch-manipulation"
			title="Attach"
			onclick={openAttach}
			aria-label="Attach"
		>
			<Paperclip class="h-5 w-5" aria-hidden="true" />
		</button>
		<button
			type="button"
			class="icon-btn h-10 w-10 p-2 touch-manipulation"
			title="Labels"
			onclick={openTags}
			aria-label="Labels"
		>
			<Tag class="h-5 w-5" aria-hidden="true" />
		</button>
	</div>

	<div class="flex max-w-[calc(100%-5.5rem)] items-center justify-end gap-1">
		<button
			type="button"
			class="icon-btn h-10 w-10 p-2 touch-manipulation"
			title="Color"
			aria-label="Color"
			onclick={() => onOpenColor?.()}
		>
			<Palette class="h-5 w-5" aria-hidden="true" />
		</button>
		{#if showCopy || showArchive || showDelete}
			<div class="relative" bind:this={actionsContainer}>
				<button
					type="button"
					class="icon-btn h-10 w-10 p-2 touch-manipulation"
					title="More note actions"
					aria-label="More note actions"
					aria-haspopup="menu"
					aria-expanded={actionsOpen}
					onclick={() => (actionsOpen = !actionsOpen)}
				>
					<MoreHorizontal class="h-5 w-5" aria-hidden="true" />
				</button>
				{#if actionsOpen}
					<div
						class="absolute bottom-12 right-0 z-30 w-44 rounded-lg border border-[var(--shard-border)] bg-[var(--shard-surface)] py-1 shadow-lg"
						role="menu"
						aria-label="Secondary note actions"
					>
						{#if showCopy}
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
								role="menuitem"
								onclick={() => {
									onCopy?.();
									actionsOpen = false;
								}}
							>
								{#if copyFlash}
									<Check class="h-4 w-4" aria-hidden="true" />
									Copied
								{:else}
									<Copy class="h-4 w-4" aria-hidden="true" />
									Copy note
								{/if}
							</button>
						{/if}
						{#if showArchive}
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
								role="menuitem"
								onclick={() => onArchive?.()}
							>
								<Archive class="h-4 w-4" aria-hidden="true" />
								{archived ? 'Unarchive' : 'Archive'}
							</button>
						{/if}
						{#if showDelete}
							<div class="my-1 border-t border-[var(--shard-border)]" role="separator"></div>
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
								role="menuitem"
								onclick={() => onDelete?.()}
							>
								<Trash2 class="h-4 w-4" aria-hidden="true" />
								Move to trash
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		{#if onClose}
			<button
				type="button"
				class="icon-btn h-10 w-10 p-2 touch-manipulation"
				title="Done"
				aria-label="Done"
				onclick={() => onClose?.()}
			>
				<Check class="h-5 w-5" aria-hidden="true" />
			</button>
		{/if}
	</div>
</footer>
