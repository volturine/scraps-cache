<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { noteToPlainText, noteAttachments } from '$lib/checklistBody';
	import { mergeHydratedImages } from '$lib/noteAttachmentHydration';
	import type { NoteColor, NoteImage } from '$lib/types';
	import { NOTE_COLORS, NOTE_DARK_COLORS } from '$lib/types';
	import ColorPalette from './ColorPalette.svelte';
	import ReminderPicker from './ReminderPicker.svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';
	import LabelMenu from './LabelMenu.svelte';
	import NoteEditorFooter from './NoteEditorFooter.svelte';
	import BodyEditor from './BodyEditor.svelte';
	import LinkPreview from './LinkPreview.svelte';
	import { extractHttpUrls } from '$lib/linkPreview';
	import { appClock } from '$lib/appClock.svelte';
	import { formatReminder, isReminderOverdue } from '$lib/utils';
	import ReminderLabel from './ReminderLabel.svelte';
	import { Bell, ChevronLeft, Paperclip, Pin } from '@lucide/svelte';
	import { revealEditorField, revealEditorPoint } from '$lib/editorVisibility';
	import { getClipboardFiles } from '$lib/noteImages';

	let {
		noteId = $bindable(),
		initialFiles = null,
		onClose,
		registerClose
	}: {
		noteId: string | null;
		initialFiles?: File[] | null;
		onClose: () => void;
		registerClose?: (close: () => void) => void;
	} = $props();

	const note = $derived(noteId ? notesStore.notes.find((n) => n.id === noteId) : null);
	const isOpen = $derived(noteId !== null && note !== null);
	const reminderOverdue = $derived(
		note?.reminder != null && isReminderOverdue(note.reminder, appClock.now)
	);
	const reminderLabel = $derived(formatReminder(note?.reminder ?? null, appClock.now));

	let taskFocusLine = $state<number | null>(null);

	// Parent remounts this editor when the note id changes, so the initial
	// draft is captured once per open note rather than synced from the store.
	// svelte-ignore state_referenced_locally
	let title = $state(note?.title ?? '');
	// svelte-ignore state_referenced_locally
	let body = $state(note?.body ?? '');
	const links = $derived(extractHttpUrls(body));
	let paletteOpen = $state(false);
	let reminderOpen = $state(false);
	let labelOpen = $state(false);
	let copyFlash = $state(false);
	let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
	// svelte-ignore state_referenced_locally
	let images = $state<NoteImage[]>(
		note ? noteAttachments(note).map((attachment) => ({ ...attachment })) : []
	);
	let draftDirty = false;
	let bodyEditor = $state<{ focusDefault(): void } | null>(null);
	let footer = $state<{ handlePickedFiles(files: File[]): void } | null>(null);
	let editorDialog = $state<HTMLDivElement | null>(null);
	let fileDropActive = $state(false);
	let editorScroller = $state<HTMLDivElement | null>(null);
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	let editorTouchGesture:
		| {
				pointerId: number;
				field: HTMLElement;
				startX: number;
				startY: number;
				startScrollTop: number;
				moved: boolean;
		  }
		| undefined;
	const TOUCH_TAP_SLOP = 8;
	const editorDialogClass = $derived(
		`relative flex h-full w-full flex-col overflow-hidden rounded-2xl${paletteOpen || labelOpen ? ' editor-caret-hidden' : ''}`
	);
	const editorDialogStyle = $derived(
		`background-color: ${note ? bgColor(note.color) : 'transparent'};`
	);

	function exitTaskFocus() {
		taskFocusLine = null;
	}

	function focusBodyFromPage(event: MouseEvent) {
		const target = event.target;
		const el = target instanceof Element ? target : null;
		// Task rows and the focused envelope manage their own chrome.
		if (el?.closest('[data-focus-group], [data-task-row], [data-add-subtask]')) return;

		// Match any contenteditable host (including plaintext-only). A strict ="true"
		// check lets page clicks steal focus and collapse multi-line iOS selections.
		if (el?.closest('button, input, textarea, select, a, [contenteditable]')) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && editorDialog?.contains(active)) {
			// Android keeps a contenteditable focused after its software-keyboard
			// dismiss action. Treat a tap on empty note chrome like the header buttons:
			// explicitly blur the field so the keyboard can close reliably.
			exitTaskFocus();
			active.blur();
			return;
		}
		if (taskFocusLine !== null) exitTaskFocus();
		bodyEditor?.focusDefault();
	}

	function revealFocusedEditorField() {
		if (!isOpen || !editorDialog || !editorScroller) return;
		const focused = document.activeElement;
		if (!(focused instanceof HTMLElement) || !editorDialog.contains(focused)) return;
		let field = focused.closest('input, textarea, select, [contenteditable]') as HTMLElement | null;
		if (!field) return;
		if (field.matches('[data-body-editor]')) {
			const anchor = window.getSelection()?.anchorNode;
			const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
			const selectedLine = anchorElement?.closest('[data-editor-line]') as HTMLElement | null;
			if (selectedLine && field.contains(selectedLine)) field = selectedLine;
		}

		revealEditorField(editorScroller, field);
	}

	function queueFocusedEditorReveal() {
		if (revealTimer !== null) clearTimeout(revealTimer);
		// Mobile browsers emit resize/scroll events throughout the keyboard animation.
		// Reveal once after those events settle instead of chasing every animation frame.
		revealTimer = setTimeout(() => {
			revealTimer = null;
			revealFocusedEditorField();
		}, 100);
	}

	onMount(() => {
		registerClose?.(() => {
			if (isOpen) void close();
		});
		if (initialFiles && initialFiles.length > 0) {
			footer?.handlePickedFiles(initialFiles);
		}
		const viewport = window.visualViewport;
		const onViewportChange = () => {
			if (!isOpen) return;
			lockPageScroll();
			queueFocusedEditorReveal();
		};
		const onFocusIn = (event: FocusEvent) => {
			if (event.target instanceof Node && editorDialog?.contains(event.target)) {
				lockPageScroll();
				queueFocusedEditorReveal();
			}
		};
		const onOuterScroll = () => lockPageScroll();
		viewport?.addEventListener('resize', onViewportChange);
		viewport?.addEventListener('scroll', onViewportChange);
		window.addEventListener('resize', onViewportChange);
		document.addEventListener('focusin', onFocusIn);
		if (noteId) {
			lockPageScroll();
			const id = noteId;
			void notesStore.ensureNoteAttachments(id).then(() => {
				const hydrated = notesStore.notes.find((item) => item.id === id);
				if (!hydrated) return;
				images = mergeHydratedImages(images, noteAttachments(hydrated));
			});
			window.addEventListener('scroll', onOuterScroll, { capture: true, passive: false });
			viewport?.addEventListener('scroll', onOuterScroll);
		}
		return () => {
			registerClose?.(() => {});
			viewport?.removeEventListener('resize', onViewportChange);
			viewport?.removeEventListener('scroll', onViewportChange);
			window.removeEventListener('resize', onViewportChange);
			document.removeEventListener('focusin', onFocusIn);
			window.removeEventListener('scroll', onOuterScroll, { capture: true });
			viewport?.removeEventListener('scroll', onOuterScroll);
			if (revealTimer !== null) clearTimeout(revealTimer);
			if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
		};
	});

	function lockPageScroll() {
		window.scrollTo(0, 0);
		document.documentElement.scrollTop = 0;
		document.body.scrollTop = 0;
	}

	function editorFieldFromTarget(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element) || !editorScroller) return null;
		const field = target.closest('textarea, input[type="text"], [contenteditable]');
		return field instanceof HTMLElement && editorScroller.contains(field) ? field : null;
	}

	function beginEditorTouch(event: PointerEvent) {
		if (event.pointerType !== 'touch' || !editorScroller) return;
		const field = editorFieldFromTarget(event.target);
		if (!field) return;
		editorTouchGesture = {
			pointerId: event.pointerId,
			field,
			startX: event.clientX,
			startY: event.clientY,
			startScrollTop: editorScroller.scrollTop,
			moved: false
		};
	}

	function moveEditorTouch(event: PointerEvent) {
		const gesture = editorTouchGesture;
		if (!gesture || event.pointerId !== gesture.pointerId || !editorScroller) return;
		if (
			Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > TOUCH_TAP_SLOP ||
			Math.abs(editorScroller.scrollTop - gesture.startScrollTop) > 1
		) {
			gesture.moved = true;
		}
	}

	function cancelEditorTouch(event: PointerEvent) {
		if (editorTouchGesture?.pointerId === event.pointerId) editorTouchGesture = undefined;
	}

	function completeEditorTouch(event: PointerEvent) {
		const gesture = editorTouchGesture;
		editorTouchGesture = undefined;
		if (
			event.pointerType !== 'touch' ||
			!editorScroller ||
			!gesture ||
			event.pointerId !== gesture.pointerId ||
			gesture.moved ||
			Math.abs(editorScroller.scrollTop - gesture.startScrollTop) > 1 ||
			editorFieldFromTarget(event.target) !== gesture.field
		) {
			return;
		}
		const field = gesture.field;

		// Establish the touch point's safe area inside the note body before Safari
		// handles the gesture. This also covers an already-active or wrapped field:
		// native caret placement no longer needs to pan the visual viewport.
		revealEditorPoint(editorScroller, event.clientY);
		lockPageScroll();
		if (document.activeElement === field) return;

		// Run the focusing step inside the touch gesture before Safari's default
		// focus action. Flush the task-focus chrome in that same transaction, then
		// compensate for its layout change around the tapped row. The note body is
		// the only scroll owner; the later native action only places the exact caret.
		const anchorTop = field.getBoundingClientRect().top;
		try {
			field.focus({ preventScroll: true });
		} catch {
			field.focus();
		}
		flushSync();
		const movedBy = field.getBoundingClientRect().top - anchorTop;
		editorScroller.scrollTop += movedBy;
		lockPageScroll();
	}

	function focusTask(line: number) {
		// The task row stays mounted, so the browser already owns the exact caret
		// and keyboard focus from the tap. Only update the inline focus chrome.
		taskFocusLine = line;
	}

	function handleBack() {
		// Always leave the note. Task focus mode must not trap the user behind a
		// second back press or block dismissing the editor.
		void close();
	}

	function closePopups() {
		paletteOpen = false;
		reminderOpen = false;
		labelOpen = false;
	}

	function openReminder() {
		closePopups();
		reminderOpen = true;
	}

	function keepEditorFocused(event: PointerEvent) {
		if (event.pointerType === 'touch') event.preventDefault();
	}

	function eventInsideEditor(target: EventTarget | null): boolean {
		return editorDialog != null && target instanceof Node && editorDialog.contains(target);
	}

	function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
		return !!dataTransfer && Array.from(dataTransfer.types).includes('Files');
	}

	function pointerLeftElement(event: DragEvent, el: EventTarget | null): boolean {
		if (!(el instanceof Element)) return true;
		const rect = el.getBoundingClientRect();
		return (
			event.clientX <= rect.left ||
			event.clientX >= rect.right ||
			event.clientY <= rect.top ||
			event.clientY >= rect.bottom
		);
	}

	function handleFileDragEnter(event: DragEvent) {
		if (!dataTransferHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		fileDropActive = true;
	}

	function handleFileDragOver(event: DragEvent) {
		if (!dataTransferHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		fileDropActive = true;
	}

	function handleFileDragLeave(event: DragEvent) {
		if (!fileDropActive || !pointerLeftElement(event, event.currentTarget)) return;
		fileDropActive = false;
	}

	function handleFileDrop(event: DragEvent) {
		if (!dataTransferHasFiles(event.dataTransfer)) return;
		event.preventDefault();
		fileDropActive = false;
		backdropPressOutside = false;
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) footer?.handlePickedFiles(files);
	}

	function handlePaste(event: ClipboardEvent) {
		if (!isOpen || !note) return;
		const target = event.target;
		if (target instanceof Element && target.closest('.canvas-editor-shell')) return;
		const files = getClipboardFiles(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (footer) {
			footer.handlePickedFiles(files);
		} else {
			queueMicrotask(() => {
				footer?.handlePickedFiles(files);
			});
		}
	}

	let backdropPressOutside = false;

	function handleBackdropPointerDown(event: PointerEvent) {
		backdropPressOutside = !eventInsideEditor(event.target);
	}

	function handleBackdropClick(event: MouseEvent) {
		// A press that starts in the note and ends on the overlay still emits a click here.
		if (!backdropPressOutside || eventInsideEditor(event.target)) return;
		void close();
	}

	function bgColor(c: NoteColor): string {
		return uiStore.effectiveDark ? NOTE_DARK_COLORS[c] : NOTE_COLORS[c];
	}

	function commit(patch: Record<string, unknown>) {
		if (!note) return;
		notesStore.updateNote(note.id, patch);
	}

	let timer: ReturnType<typeof setTimeout> | null = null;
	function scheduleCommit() {
		draftDirty = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (!note) return;
			commit({ title, body, images, linkPreviews: [] });
		}, 250);
	}

	function commitNow(nextImages?: NoteImage[]) {
		if (!note) return;
		draftDirty = true;
		commit({ title, body, images: nextImages ?? images });
	}

	async function close() {
		// Drop task-focus chrome immediately so dismiss is never gated on focus mode.
		taskFocusLine = null;
		if (timer) clearTimeout(timer);
		if (note && draftDirty) {
			commit({ title, body, images, linkPreviews: [] });
			try {
				await notesStore.flushNote(note.id, { title, body, images, linkPreviews: [] });
			} catch (err) {
				console.error('[NoteEditor] flush failed:', err);
			}
		}
		if (note) await notesStore.discardIfEmpty(note.id);
		onClose();
		void notesStore.syncPendingChanges();
	}

	async function copyText() {
		if (!note) return;
		const text = noteToPlainText({ ...note, title, body });
		let copied = false;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			try {
				copied = document.execCommand('copy');
			} catch {}
			document.body.removeChild(ta);
		}
		// Only confirm when the write actually landed; the button must not claim a
		// copy that failed (e.g. insecure origins where the async API is missing).
		if (!copied) return;
		copyFlash = true;
		if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
		copyFlashTimer = setTimeout(() => {
			copyFlash = false;
			copyFlashTimer = null;
		}, 1500);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (isOpen && e.key === 'Escape') void close();
	}}
	onpastecapture={handlePaste}
/>

{#if isOpen && note}
	<div
		class="fixed inset-0 z-50"
		role="presentation"
		onpointerdown={handleBackdropPointerDown}
		onclick={handleBackdropClick}
		ondragenter={handleFileDragEnter}
		ondragovercapture={handleFileDragOver}
		ondragleave={handleFileDragLeave}
		ondropcapture={handleFileDrop}
		onpastecapture={handlePaste}
	>
		<div
			class="absolute inset-0 flex items-start justify-center px-4 pb-[var(--app-sheet-pad-bottom)] md:items-center"
			role="presentation"
		>
			<!-- Clicking blank editor chrome is a pointer convenience; keyboard users focus the fields directly. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				class="note-sheet-shadow h-full max-h-full min-h-0 w-full max-w-2xl rounded-2xl md:h-[72%]"
			>
				<div
					bind:this={editorDialog}
					class={editorDialogClass}
					style={editorDialogStyle}
					role="dialog"
					tabindex="-1"
					aria-modal="true"
					onpointerdown={beginEditorTouch}
					onpointermove={moveEditorTouch}
					onpointerup={completeEditorTouch}
					onpointercancel={cancelEditorTouch}
					onclick={focusBodyFromPage}
				>
					<!-- Header -->
					<header
						class="flex shrink-0 items-center gap-2 border-b border-black/5 px-2 py-2 dark:border-white/10"
					>
						<button
							type="button"
							class="icon-btn h-10 w-10 p-2"
							title="Close note"
							onclick={handleBack}
							aria-label="Close note"
						>
							<ChevronLeft class="h-6 w-6" aria-hidden="true" />
						</button>

						<div class="flex-1" aria-hidden="true"></div>

						<div class="flex min-w-0 items-center gap-1">
							{#if note.reminder != null}
								<button
									type="button"
									class="min-w-0"
									title={reminderOverdue ? `Overdue · ${reminderLabel}` : reminderLabel}
									onclick={openReminder}
									aria-label={reminderOverdue
										? `Overdue reminder, ${reminderLabel}`
										: `Reminder, ${reminderLabel}`}
								>
									<ReminderLabel reminder={note.reminder} variant="chip" />
								</button>
							{/if}
							<button
								type="button"
								class="icon-btn h-9 w-9 p-2 {note.reminder == null
									? ''
									: reminderOverdue
										? 'text-rose-600 dark:text-rose-400'
										: 'text-blue-600 dark:text-blue-400'}"
								title="Reminder"
								onclick={openReminder}
								aria-label="Reminder"
							>
								<Bell class="h-5 w-5" aria-hidden="true" />
							</button>
							<button
								type="button"
								class="icon-btn h-9 w-9 p-2"
								title={note.pinned ? 'Unpin' : 'Pin'}
								onclick={() => commit({ pinned: !note.pinned })}
								aria-label="Pin"
							>
								<Pin
									class="h-5 w-5"
									fill={note.pinned ? 'currentColor' : 'none'}
									aria-hidden="true"
								/>
							</button>
						</div>
					</header>

					<div
						bind:this={editorScroller}
						class="note-scrollbar-hidden scrollable min-h-0 flex-1 touch-pan-y overflow-y-auto overflow-x-hidden overscroll-contain px-6 pt-4 pb-3"
					>
						<input
							type="text"
							placeholder="Title"
							bind:value={title}
							oninput={scheduleCommit}
							onfocus={exitTaskFocus}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									bodyEditor?.focusDefault();
								}
							}}
							class="mb-3 block w-full bg-transparent text-xl font-medium text-[var(--scrapscache-text)] placeholder:text-[var(--scrapscache-text-muted)] outline-none"
						/>

						<BodyEditor
							bind:this={bodyEditor}
							bind:body
							oninput={scheduleCommit}
							placeholder="Take a note… type [ ] for a checklist, - for a bullet, Tab for sub-task"
							focusLine={taskFocusLine}
							onFocusTask={focusTask}
							onExitTaskFocus={exitTaskFocus}
						/>

						{#if links.length > 0}
							<div class="mt-3 flex flex-col gap-2" aria-label="Links">
								{#each links as url (url)}
									<LinkPreview {url} />
								{/each}
							</div>
						{/if}
					</div>

					{#if fileDropActive}
						<div
							class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--scrapscache-accent)] bg-[color-mix(in_oklab,var(--scrapscache-accent)_16%,transparent)]"
							data-file-drop-hint
							aria-hidden="true"
						>
							<div
								class="flex items-center gap-2 rounded-full bg-[var(--scrapscache-surface)] px-4 py-2 text-sm font-medium text-[var(--scrapscache-text)] shadow-sm"
							>
								<Paperclip class="h-4 w-4" aria-hidden="true" />
								Drop to attach
							</div>
						</div>
					{/if}

					<NoteEditorFooter
						bind:this={footer}
						bind:images
						bind:body
						noteId={note.id}
						hasLabels={(note.labels?.length ?? 0) > 0}
						showCopy={true}
						showArchive={true}
						showDelete={true}
						archived={note.archived}
						trashed={note.trashed}
						{copyFlash}
						onOpenColor={() => {
							closePopups();
							paletteOpen = true;
						}}
						onOpenTags={() => {
							closePopups();
							labelOpen = true;
						}}
						onCopy={() => void copyText()}
						onArchive={() => {
							if (note.trashed) notesStore.restoreNote(note.id);
							else notesStore.toggleArchive(note.id);
							void close();
						}}
						onDelete={() => {
							if (note.trashed) void notesStore.deleteNoteForever(note.id);
							else notesStore.trashNote(note.id);
							close();
						}}
						onImagesChange={(imgs) => commitNow(imgs)}
					/>
				</div>
			</div>
		</div>
	</div>

	<!-- Popups render at the viewport level so they're never clipped by the dialog -->
	{#if paletteOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="fixed inset-0 z-[60] bg-black/30"
			onpointerdown={keepEditorFocused}
			onclick={() => {
				paletteOpen = false;
			}}
			role="presentation"
		></div>
		<div
			data-editor-popup
			class="fixed z-[61] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
			onpointerdown={keepEditorFocused}
			role="presentation"
		>
			<ColorPalette
				color={note.color}
				onSelect={(c) => {
					commit({ color: c });
					paletteOpen = false;
				}}
			/>
		</div>
	{/if}

	{#if reminderOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="fixed inset-0 z-[60] bg-black/30"
			onclick={() => {
				reminderOpen = false;
			}}
			role="presentation"
		></div>
		<div data-editor-popup class="fixed z-[61] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
			<ReminderPicker
				reminder={note.reminder}
				onApply={(r) => {
					commit({ reminder: r });
					reminderStore.sync(notesStore.notes);
					void notesStore.flushSync();
				}}
				onClose={() => {
					reminderOpen = false;
				}}
			/>
		</div>
	{/if}

	{#if labelOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="fixed inset-0 z-[60] bg-black/30"
			onpointerdown={keepEditorFocused}
			onclick={() => {
				labelOpen = false;
			}}
			role="presentation"
		></div>
		<div data-editor-popup class="fixed z-[61] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
			<LabelMenu
				noteId={note.id}
				onClose={() => {
					labelOpen = false;
				}}
			/>
		</div>
	{/if}
{/if}
