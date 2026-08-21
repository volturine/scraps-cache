import type { View } from '$lib/stores/ui.svelte';

/** Single source of truth for the URL ↔ view mapping. */
export function pathForView(view: View, labelId: string | null = null): string | null {
	switch (view) {
		case 'notes':
			return '/';
		case 'kanban':
			return '/kanban';
		case 'reminders':
			return '/reminders';
		case 'archive':
			return '/archive';
		case 'trash':
			return '/trash';
		case 'label':
			return labelId ? `/label/${labelId}` : null;
	}
}

export interface ViewTarget {
	view: View;
	labelId: string | null;
}

export function viewForPath(pathname: string): ViewTarget {
	if (pathname.startsWith('/label/')) {
		return { view: 'label', labelId: decodeURIComponent(pathname.slice('/label/'.length)) };
	}
	switch (pathname) {
		case '/kanban':
			return { view: 'kanban', labelId: null };
		case '/reminders':
			return { view: 'reminders', labelId: null };
		case '/archive':
			return { view: 'archive', labelId: null };
		case '/trash':
			return { view: 'trash', labelId: null };
		default:
			return { view: 'notes', labelId: null };
	}
}
