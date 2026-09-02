<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import ReminderCalendar from '$lib/components/ReminderCalendar.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { AlarmClock } from '@lucide/svelte';
	import { dayKey } from '$lib/utils';
	import { notesShellClass } from '$lib/notesShell';
	import { MediaQuery } from 'svelte/reactivity';

	const { openNote: openEditor } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);

	/** Phone widths keep the calendar full-width; wider grids pack it alongside note cards. */
	const compact = new MediaQuery('max-width: 767px', true);

	const searched = $derived(
		uiStore.search ? notesStore.search(uiStore.search, reminders) : reminders
	);
	const visible = $derived.by(() => {
		const sel = uiStore.reminderFilter;
		if (!sel) return searched;
		const to = sel.to ?? sel.from;
		return searched.filter((n) => {
			if (n.reminder == null) return false;
			const key = dayKey(n.reminder);
			return key >= sel.from && key <= to;
		});
	});
	const embedCalendar = $derived(uiStore.layout === 'grid' && !compact.current);
	const emptyDescription = $derived(
		reminders.length === 0
			? 'Create a note, then add a reminder when you need to return to it.'
			: uiStore.reminderFilter || uiStore.search
				? 'No reminders match the current filters.'
				: 'Create a note, then add a reminder when you need to return to it.'
	);
</script>

<div class="pt-4 pb-8">
	{#if embedCalendar}
		<div class="relative">
			<NotesFeed notes={visible} onOpen={openEditor}>
				{#snippet leading()}
					<ReminderCalendar notes={reminders} bind:selected={uiStore.reminderFilter} />
				{/snippet}
			</NotesFeed>
			{#if visible.length === 0}
				<div
					class="flex justify-center px-4 py-10 md:absolute md:inset-y-0 md:right-0 md:left-[min(32rem,58%)] md:items-center md:py-0"
				>
					<EmptyState icon={AlarmClock} description={emptyDescription} />
				</div>
			{/if}
		</div>
	{:else}
		<div class={uiStore.layout === 'list' ? notesShellClass() : 'w-full'}>
			<ReminderCalendar notes={reminders} bind:selected={uiStore.reminderFilter} />
		</div>
		<div class="mt-4">
			{#if visible.length === 0}
				<EmptyState icon={AlarmClock} description={emptyDescription} />
			{:else}
				<NotesFeed notes={visible} onOpen={openEditor} />
			{/if}
		</div>
	{/if}
</div>
