<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import ReminderCalendar, {
		type ReminderDayFilter
	} from '$lib/components/ReminderCalendar.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { AlarmClock } from '@lucide/svelte';
	import { dayKey } from '$lib/utils';
	import { notesShellClass } from '$lib/notesShell';

	const { openNote: openEditor } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
	let selectedDay = $state<ReminderDayFilter | null>(null);

	/** Phone widths keep the calendar as a full-width block; wider screens pack it into the note grid. */
	let isCompact = $state(true);
	$effect(() => {
		if (typeof matchMedia === 'undefined') return;
		const mq = matchMedia('(max-width: 767px)');
		const update = () => (isCompact = mq.matches);
		update();
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	});

	const searched = $derived(
		uiStore.search ? notesStore.search(uiStore.search, reminders) : reminders
	);
	const visible = $derived.by(() => {
		const sel = selectedDay;
		if (!sel) return searched;
		const to = sel.to ?? sel.from;
		return searched.filter((n) => {
			if (n.reminder == null) return false;
			const key = dayKey(n.reminder);
			return key >= sel.from && key <= to;
		});
	});
	const embedCalendar = $derived(uiStore.layout === 'grid' && !isCompact && visible.length > 0);
</script>

<div class="pt-4 pb-8">
	{#if embedCalendar}
		<NotesFeed notes={visible} onOpen={openEditor}>
			{#snippet leading()}
				<ReminderCalendar notes={reminders} bind:selected={selectedDay} />
			{/snippet}
		</NotesFeed>
	{:else}
		<div class={notesShellClass()}>
			<ReminderCalendar notes={reminders} bind:selected={selectedDay} />
		</div>
		<div class="mt-4">
			{#if reminders.length === 0}
				<EmptyState
					icon={AlarmClock}
					description="Create a note, then add a reminder when you need to return to it."
				/>
			{:else if visible.length === 0}
				<EmptyState
					icon={AlarmClock}
					description={selectedDay || uiStore.search
						? 'No reminders match the current filters.'
						: 'Create a note, then add a reminder when you need to return to it.'}
				/>
			{:else}
				<NotesFeed notes={visible} onOpen={openEditor} />
			{/if}
		</div>
	{/if}
</div>
