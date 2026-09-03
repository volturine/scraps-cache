<script lang="ts">
	import AttachmentFullscreen from '$lib/components/AttachmentFullscreen.svelte';
	import CanvasEditor from '$lib/components/CanvasEditor.svelte';
	import PhotoFullscreen from '$lib/components/PhotoFullscreen.svelte';
	import type { Note, NoteImage } from '$lib/types';
	import { parseBody, noteAttachments } from '$lib/checklistBody';
	import { extractHttpUrls } from '$lib/linkPreview';
	import LinkPreview from './LinkPreview.svelte';
	import {
		isImageAttachment,
		isInlinePreviewable,
		fileIconLabel,
		openAttachment
	} from '$lib/noteImages';
	import { displayImageSrc } from '$lib/imageThumb';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { onMount } from 'svelte';
	import { isCanvasAttachment, mergeCanvasEdit } from '$lib/canvasAttachment';

	let { note }: { note: Note } = $props();

	const segments = $derived(parseBody(note.body ?? ''));
	const attachments = $derived(noteAttachments(note));
	const imageAttachments = $derived(attachments.filter(isImageAttachment));
	const canvases = $derived(attachments.filter(isCanvasAttachment));
	const photos = $derived(imageAttachments.filter((attachment) => !!displayImageSrc(attachment)));
	const pendingPhotos = $derived(
		imageAttachments.filter((attachment) => !displayImageSrc(attachment))
	);
	const files = $derived(
		attachments.filter((a) => !isImageAttachment(a) && !isCanvasAttachment(a))
	);
	const links = $derived(extractHttpUrls(note.body ?? ''));
	let focusedImageId = $state<string | null>(null);
	let focusedAttachment = $state<NoteImage | null>(null);
	let focusedCanvas = $state<NoteImage | null>(null);
	let contentElement: HTMLDivElement | null = $state(null);

	onMount(() => {
		// Cards only need thumbs. Full bytes load on explicit open / editor focus.
		const node = contentElement;
		const needsThumbOrFile = (note.images ?? []).some((attachment) => {
			if (isImageAttachment(attachment) || isCanvasAttachment(attachment)) {
				return !displayImageSrc(attachment);
			}
			return !attachment.dataUrl;
		});
		if (!node || !needsThumbOrFile) return;
		const request = () => notesStore.requestVisibleNoteAttachments(note.id);
		if (!('IntersectionObserver' in window)) {
			const frame = requestAnimationFrame(request);
			return () => cancelAnimationFrame(frame);
		}
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			request();
		});
		observer.observe(node);
		return () => observer.disconnect();
	});

	async function focusImage(id: string, event: MouseEvent) {
		event.stopPropagation();
		await notesStore.ensureNoteAttachments(note.id);
		focusedImageId = id;
	}

	async function focusCanvas(id: string, event: MouseEvent) {
		event.stopPropagation();
		await notesStore.ensureNoteAttachments(note.id);
		const current = notesStore.notes.find((item) => item.id === note.id);
		const canvas = current?.images?.find((item) => item.id === id);
		if (canvas?.dataUrl) focusedCanvas = { ...canvas };
	}

	async function saveCanvas(saved: NoteImage, sourceHash?: string) {
		const currentNote = notesStore.notes.find((item) => item.id === note.id);
		const currentImages = currentNote?.images ?? attachments;
		const next = mergeCanvasEdit(currentImages, saved, sourceHash).attachments;
		notesStore.updateNote(note.id, { images: next });
		await notesStore.flushNote(note.id);
	}

	async function openFile(event: MouseEvent, id: string) {
		event.stopPropagation();
		await notesStore.ensureNoteAttachments(note.id);
		const current = notesStore.notes.find((item) => item.id === note.id);
		const file =
			current?.images?.find((item) => item.id === id) ?? files.find((item) => item.id === id);
		if (!file?.dataUrl) return;
		if (isInlinePreviewable(file)) focusedAttachment = { ...file };
		else void openAttachment(file);
	}

	function toggle(lineIndex: number) {
		notesStore.toggleBodyChecklistLine(note.id, lineIndex);
	}
</script>

<div bind:this={contentElement} class="text-sm text-[var(--scrapscache-text)]">
	{#each segments as seg (seg.lineIndex)}
		{#if seg.type === 'check'}
			<div
				class="flex items-start gap-2 py-0.5"
				data-check-line={seg.lineIndex}
				style={seg.indent > 0 ? `padding-left: ${seg.indent * 1.25}rem` : undefined}
			>
				<button
					type="button"
					data-checklist-toggle
					class="checklist-toggle shrink-0 {seg.indent > 0 ? 'checklist-toggle-sub' : ''}"
					class:checked={seg.checked}
					onclick={(e) => {
						e.stopPropagation();
						toggle(seg.lineIndex);
					}}
					aria-label={seg.indent > 0 ? 'Toggle sub-task' : 'Toggle item'}
					aria-pressed={seg.checked}
				>
					{#if seg.checked}
						<svg viewBox="0 0 16 16" class="checklist-toggle-mark" aria-hidden="true">
							<path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
						</svg>
					{/if}
				</button>
				<span
					class="flex-1 break-words {seg.checked ? 'line-through opacity-50' : ''} {seg.indent > 0
						? 'text-[13px]'
						: ''}"
				>
					{seg.text || '\u00a0'}
				</span>
			</div>
		{:else if seg.type === 'bullet'}
			<div
				class="flex items-start gap-2 py-0.5"
				data-bullet-line={seg.lineIndex}
				style={seg.indent > 0 ? `padding-left: ${seg.indent * 1.25}rem` : undefined}
			>
				<span class="shrink-0 select-none" aria-hidden="true">•</span>
				<span class="flex-1 break-words {seg.indent > 0 ? 'text-[13px]' : ''}">
					{seg.text || '\u00a0'}
				</span>
			</div>
		{:else if seg.text}
			<p class="whitespace-pre-wrap break-words py-0.5">{seg.text}</p>
		{:else}
			<div class="h-2"></div>
		{/if}
	{/each}
</div>

{#if links.length > 0}
	<div class="mt-2 flex flex-col gap-2">
		{#each links as url (url)}
			<LinkPreview {url} />
		{/each}
	</div>
{/if}

{#if canvases.length > 0}
	<div class="mt-2 grid gap-1.5" aria-label="Canvases">
		{#each canvases as canvas (canvas.id)}
			<button
				type="button"
				class="group relative block aspect-[4/3] w-full touch-manipulation overflow-hidden rounded-lg border border-black/10 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/10 dark:bg-slate-900"
				data-canvas
				onclick={(event) => void focusCanvas(canvas.id, event)}
				aria-label={`${note.trashed ? 'View' : 'Edit'} ${canvas.name ?? 'canvas'}`}
			>
				{#if displayImageSrc(canvas)}
					<img
						src={displayImageSrc(canvas)}
						alt={canvas.name ?? 'Canvas'}
						class="h-full w-full object-cover"
						loading="lazy"
						decoding="async"
					/>
				{:else}
					<div
						class="grid h-full w-full place-items-center text-[11px] text-[var(--scrapscache-text-muted)]"
					>
						Loading canvas…
					</div>
				{/if}
				<span
					class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-5 text-left text-[10px] font-semibold text-white"
				>
					{canvas.name ?? 'Canvas'}
				</span>
			</button>
		{/each}
	</div>
{/if}

{#if photos.length > 0 || pendingPhotos.length > 0}
	<div class="mt-2 flex flex-wrap gap-1.5">
		{#each photos as img (img.id)}
			<button
				type="button"
				class="block max-w-full touch-manipulation overflow-hidden rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
				data-photo
				onclick={(event) => focusImage(img.id, event)}
				aria-label={`Open ${img.name ?? 'photo'}`}
			>
				<img
					src={displayImageSrc(img)}
					alt={img.name ?? 'Photo'}
					class="max-h-32 max-w-full rounded-lg object-cover"
					loading="lazy"
					decoding="async"
				/>
			</button>
		{/each}
		{#each pendingPhotos as img (img.id)}
			<div
				class="h-24 w-24 animate-pulse rounded-lg bg-black/10 dark:bg-white/10"
				role="img"
				aria-label={`Loading ${img.name ?? 'photo'}`}
			></div>
		{/each}
	</div>
{/if}

{#if files.length > 0}
	<div class="mt-2 flex flex-col gap-1">
		{#each files as file (file.id)}
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded-md border border-black/10 bg-black/5 px-2 py-1.5 text-left touch-manipulation dark:border-white/10 dark:bg-white/5"
				data-file
				aria-busy={!file.dataUrl}
				onclick={(event) => void openFile(event, file.id)}
				aria-label={`Open ${file.name ?? 'file'}`}
			>
				<span
					class="grid h-7 w-7 shrink-0 place-items-center rounded bg-black/10 text-[9px] font-bold text-[var(--scrapscache-text)] dark:bg-white/10"
					>{fileIconLabel(file.mime, file.name)}</span
				>
				<span class="min-w-0 flex-1 truncate text-xs text-[var(--scrapscache-text)]"
					>{file.name || 'File'}</span
				>
			</button>
		{/each}
	</div>
{/if}

<PhotoFullscreen
	images={photos}
	bind:activeIndex={
		() => {
			if (focusedImageId === null) return null;
			const index = photos.findIndex((photo) => photo.id === focusedImageId);
			return index >= 0 ? index : null;
		},
		(index) => {
			focusedImageId = index === null ? null : (photos[index]?.id ?? null);
		}
	}
/>
{#if focusedCanvas}
	<CanvasEditor
		attachment={focusedCanvas}
		readOnly={note.trashed}
		onSave={saveCanvas}
		onClose={() => {
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
