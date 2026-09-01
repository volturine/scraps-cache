<script lang="ts">
	import AttachmentFullscreen from '$lib/components/AttachmentFullscreen.svelte';
	import CanvasEditor from '$lib/components/CanvasEditor.svelte';
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
	import type { ImageQuality } from '$lib/imageOptimize';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { sha256 } from '$lib/syncHash';
	import { formatStorageError } from '$lib/imageBlob';
	import { isKeyboardField } from '$lib/appViewport';
	import { isCanvasAttachment, mergeCanvasEdit } from '$lib/canvasAttachment';
	import {
		Archive,
		ArchiveRestore,
		Check,
		Copy,
		Palette,
		Paperclip,
		PenLine,
		RotateCcw,
		Tag,
		Trash2,
		X
	} from '@lucide/svelte';

	let {
		images = $bindable<NoteImage[]>([]),
		body = $bindable(''),
		noteId = null as string | null,
		hasLabels = false,
		showCopy = false,
		showArchive = false,
		showDelete = false,
		archived = false,
		trashed = false,
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
		hasLabels?: boolean;
		showCopy?: boolean;
		showArchive?: boolean;
		showDelete?: boolean;
		archived?: boolean;
		trashed?: boolean;
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
	let canvasEditorOpen = $state(false);
	let focusedCanvas = $state<NoteImage | null>(null);
	let attachError = $state('');
	let filesAwaitingQuality = $state<File[] | null>(null);

	const imageAttachments = $derived(images.filter(isImageAttachment));
	const canvases = $derived(images.filter(isCanvasAttachment));
	const photos = $derived(imageAttachments.filter((attachment) => !!displayImageSrc(attachment)));
	const pendingPhotos = $derived(
		imageAttachments.filter((attachment) => !displayImageSrc(attachment))
	);
	const files = $derived(images.filter((a) => !isImageAttachment(a) && !isCanvasAttachment(a)));
	const photoIndexById = $derived(new Map(photos.map((p, i) => [p.id, i])));

	/**
	 * Normal button: each press creates a one-shot file input in this gesture,
	 * opens the system picker, then discards the input so cancel cannot stick.
	 */
	function openAttach() {
		attachError = '';
		const active = document.activeElement;
		if (active instanceof HTMLElement && isKeyboardField(active)) active.blur();
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
				if (picked.length > 0) handlePickedFiles(picked);
			},
			{ once: true }
		);

		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVis);

		input.click();
	}

	function looksLikePhoto(file: File): boolean {
		return (
			file.type.toLowerCase().startsWith('image/') ||
			/\.(?:avif|dng|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name)
		);
	}

	function handlePickedFiles(picked: File[]) {
		if (picked.some(looksLikePhoto)) {
			filesAwaitingQuality = picked;
			return;
		}
		void addFiles(picked, 'compressed');
	}

	function chooseImageQuality(quality: ImageQuality) {
		const picked = filesAwaitingQuality;
		filesAwaitingQuality = null;
		if (picked) void addFiles(picked, quality);
	}

	async function addFiles(picked: File[], imageQuality: ImageQuality) {
		attachError = '';
		try {
			const added = await Promise.all(picked.map((file) => fileToNoteImage(file, imageQuality)));
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

	async function openCanvas(attachment?: NoteImage) {
		attachError = '';
		if (!attachment) {
			focusedCanvas = null;
			canvasEditorOpen = true;
			return;
		}
		let source = attachment;
		if (!source.dataUrl && noteId) {
			await notesStore.ensureNoteAttachments(noteId);
			const hydratedNote = notesStore.notes.find((note) => note.id === noteId);
			source = hydratedNote?.images?.find((item) => item.id === attachment.id) ?? source;
		}
		if (!source.dataUrl) {
			attachError = 'Canvas data is not available on this device.';
			return;
		}
		focusedCanvas = { ...source };
		canvasEditorOpen = true;
	}

	async function saveCanvas(saved: NoteImage, sourceHash?: string) {
		const storeNote = noteId ? notesStore.notes.find((note) => note.id === noteId) : undefined;
		const currentImages = storeNote?.images ?? images;
		const merged = mergeCanvasEdit(currentImages, saved, sourceHash);
		if (merged.conflict) {
			attachError = 'The synced canvas changed while you were drawing, so both versions were kept.';
		}
		const next = merged.attachments;
		images = next;
		onImagesChange?.(next);
		if (noteId) await notesStore.flushNote(noteId, { images: next });
	}

	function keepFooterStationary(event: PointerEvent) {
		if (event.pointerType !== 'touch') return;
		const target = event.target instanceof Element ? event.target : null;
		if (!target?.closest('button')) return;
		// Moving focus on pointerdown starts Android's keyboard-close resize. The
		// footer then moves before pointerup and Chrome cancels the button click.
		event.preventDefault();
	}

	function footerInteractions(node: HTMLElement) {
		node.addEventListener('pointerdown', keepFooterStationary);
		return {
			destroy() {
				node.removeEventListener('pointerdown', keepFooterStationary);
			}
		};
	}
</script>

{#if attachError}
	<p class="px-3 pb-1 text-xs text-red-600 dark:text-red-400">{attachError}</p>
{/if}

{#if canvases.length > 0}
	<div class="scrollable flex max-h-44 gap-2 overflow-x-auto px-3 pb-2" aria-label="Canvases">
		{#each canvases as canvas (canvas.id)}
			<div class="relative w-36 shrink-0">
				<button
					type="button"
					class="group block aspect-[4/3] w-full overflow-hidden rounded-lg border border-black/10 bg-white touch-manipulation dark:border-white/10 dark:bg-slate-900"
					onclick={() => void openCanvas(canvas)}
					aria-label={`Edit ${canvas.name ?? 'canvas'}`}
				>
					{#if displayImageSrc(canvas)}
						<img
							src={displayImageSrc(canvas)}
							alt={canvas.name ?? 'Canvas'}
							class="h-full w-full object-contain"
							loading="lazy"
							decoding="async"
						/>
					{:else}
						<div
							class="grid h-full place-items-center text-xs text-[var(--scrapscache-text-muted)]"
						>
							Loading canvas…
						</div>
					{/if}
					<span
						class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-5 text-left text-[11px] font-medium text-white"
					>
						{canvas.name ?? 'Canvas'}
					</span>
				</button>
				<button
					type="button"
					class="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-xs text-white touch-manipulation"
					onclick={() => removeAttachment(canvas.id)}
					aria-label="Remove canvas"
				>
					<X class="h-3 w-3" aria-hidden="true" />
				</button>
			</div>
		{/each}
	</div>
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
{/if}

{#if files.length > 0}
	<ul class="scrollable max-h-36 space-y-1.5 overflow-y-auto px-3 pb-2">
		{#each files as file (file.id)}
			<li
				class="flex items-center gap-2 rounded-lg border border-black/10 bg-black/5 px-2 py-1.5 dark:border-white/10 dark:bg-white/5"
			>
				<span
					class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-black/10 text-[10px] font-bold tracking-wide text-[var(--scrapscache-text)] dark:bg-white/10"
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
					<div class="truncate text-sm text-[var(--scrapscache-text)]">
						{file.name || 'Attachment'}
					</div>
					<div class="text-[10px] text-[var(--scrapscache-text-muted)]">
						{formatBytes(dataUrlByteLength(file.dataUrl))}
					</div>
				</button>
				<button
					type="button"
					class="shrink-0 rounded-full px-1.5 py-0.5 text-xs text-[var(--scrapscache-text-muted)] touch-manipulation"
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
{#if canvasEditorOpen}
	<CanvasEditor
		attachment={focusedCanvas}
		onSave={saveCanvas}
		onClose={() => {
			canvasEditorOpen = false;
			focusedCanvas = null;
		}}
	/>
{/if}
{#if focusedAttachment}
	<AttachmentFullscreen
		attachment={focusedAttachment}
		onClose={() => {
			focusedAttachment = null;
		}}
	/>
{/if}

{#if filesAwaitingQuality}
	<div
		class="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) filesAwaitingQuality = null;
		}}
	>
		<div
			class="scrapscache-dialog w-full max-w-sm p-4 text-[var(--scrapscache-text)]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="photo-quality-title"
		>
			<div class="mb-3 flex items-start justify-between gap-3">
				<div>
					<h2 id="photo-quality-title" class="text-base font-semibold">Photo quality</h2>
					<p class="mt-0.5 text-xs text-[var(--scrapscache-text-muted)]">
						Choose once for {filesAwaitingQuality.length === 1
							? 'this attachment'
							: `these ${filesAwaitingQuality.length} attachments`}.
					</p>
				</div>
				<button
					type="button"
					class="icon-btn h-9 w-9 shrink-0 p-2 touch-manipulation"
					onclick={() => (filesAwaitingQuality = null)}
					aria-label="Cancel attachments"
				>
					<X class="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button
					type="button"
					class="scrapscache-button scrapscache-button-primary min-h-20 px-3 py-3 text-left"
					onclick={() => chooseImageQuality('compressed')}
				>
					<span class="block text-sm font-semibold">Compressed</span>
					<span class="mt-1 block text-[11px] leading-4 opacity-85">
						Small file · A4 text stays readable
					</span>
				</button>
				<button
					type="button"
					class="scrapscache-button scrapscache-button-secondary min-h-20 px-3 py-3 text-left"
					onclick={() => chooseImageQuality('hd')}
				>
					<span class="block text-sm font-semibold">HD</span>
					<span class="mt-1 block text-[11px] leading-4 text-[var(--scrapscache-text-muted)]">
						Sharper image · larger file
					</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<footer
	use:footerInteractions
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
			title="New canvas"
			onclick={() => void openCanvas()}
			aria-label="New canvas"
		>
			<PenLine class="h-5 w-5" aria-hidden="true" />
		</button>
		<button
			type="button"
			class="icon-btn h-10 w-10 p-2 touch-manipulation"
			title="Labels"
			onclick={openTags}
			aria-label="Labels"
		>
			<Tag class="h-5 w-5" fill={hasLabels ? 'currentColor' : 'none'} aria-hidden="true" />
		</button>
	</div>

	<div class="flex max-w-[calc(100%-5.5rem)] flex-wrap items-center justify-end gap-1">
		<button
			type="button"
			class="icon-btn h-10 w-10 p-2 touch-manipulation"
			title="Color"
			aria-label="Color"
			onclick={() => onOpenColor?.()}
		>
			<Palette class="h-5 w-5" aria-hidden="true" />
		</button>
		{#if showCopy}
			<button
				type="button"
				class="icon-btn h-10 w-10 p-2 touch-manipulation"
				title="Copy note"
				aria-label="Copy note"
				onclick={() => onCopy?.()}
			>
				{#if copyFlash}
					<Check class="h-5 w-5" aria-hidden="true" />
				{:else}
					<Copy class="h-5 w-5" aria-hidden="true" />
				{/if}
			</button>
		{/if}
		{#if showArchive}
			<button
				type="button"
				class="icon-btn h-10 w-10 p-2 touch-manipulation"
				title={trashed ? 'Restore' : archived ? 'Unarchive' : 'Archive'}
				aria-label={trashed ? 'Restore' : archived ? 'Unarchive' : 'Archive'}
				onclick={() => onArchive?.()}
			>
				{#if trashed}
					<RotateCcw class="h-5 w-5" aria-hidden="true" />
				{:else if archived}
					<ArchiveRestore class="h-5 w-5" aria-hidden="true" />
				{:else}
					<Archive class="h-5 w-5" aria-hidden="true" />
				{/if}
			</button>
		{/if}
		{#if showDelete}
			<button
				type="button"
				class="icon-btn h-10 w-10 p-2 text-red-600 touch-manipulation dark:text-red-400"
				title="Delete note"
				aria-label="Delete note"
				onclick={() => onDelete?.()}
			>
				<Trash2 class="h-5 w-5" aria-hidden="true" />
			</button>
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
