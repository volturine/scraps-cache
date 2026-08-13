// Shared context: open existing note or start a new one in the same editor modal.
import { getContext, setContext } from 'svelte';

export type EditorActions = {
	openNote: (id: string) => void;
	startNewNote: () => void;
};

const KEY = Symbol('editorActions');

export function provideEditorActions(actions: EditorActions): void {
	setContext<EditorActions>(KEY, actions);
}

export function useEditorActions(): EditorActions {
	const fn = getContext<EditorActions>(KEY);
	if (!fn) {
		return { openNote: () => {}, startNewNote: () => {} };
	}
	return fn;
}
