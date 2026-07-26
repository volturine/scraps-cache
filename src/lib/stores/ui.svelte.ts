// Rune-based UI store: sidebar open, dark mode, density, active view, search.
export type Layout = 'grid' | 'list';
export type View = 'notes' | 'kanban' | 'reminders' | 'archive' | 'trash' | 'label';

interface UIState {
	sidebarOpen: boolean;
	dark: boolean | null; // null = follow system
	layout: Layout;
	view: View;
	activeLabelId: string | null;
	search: string;
	settingsOpen: boolean;
}

function prefersDark(): boolean {
	if (typeof matchMedia === 'undefined') return false;
	return matchMedia('(prefers-color-scheme: dark)').matches;
}

const LS_KEY = 'gkc-ui-state';

export class UIStore {
	sidebarOpen = $state(true);
	/** Explicit preference. `null` means follow the operating system. */
	dark = $state<boolean | null>(null);
	private systemDark = $state(prefersDark());
	layout = $state<Layout>('grid');
	view = $state<View>('notes');
	activeLabelId = $state<string | null>(null);
	// Ephemeral route-feedback state; never persisted across a reload.
	pendingPath = $state<string | null>(null);
	search = $state('');
	settingsOpen = $state(false);

	constructor() {
		if (typeof localStorage !== 'undefined') {
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (raw) {
					const parsed = JSON.parse(raw) as Partial<UIState>;
					if (typeof parsed.sidebarOpen === 'boolean') this.sidebarOpen = parsed.sidebarOpen;
					if (typeof parsed.dark === 'boolean' || parsed.dark === null) this.dark = parsed.dark;
					if (parsed.layout === 'grid' || parsed.layout === 'list') this.layout = parsed.layout;
					if (typeof parsed.view === 'string') this.view = parsed.view as View;
				}
			} catch {
				/* ignore */
			}
		}
		// Persist on change.
		$effect.root(() => {
			$effect(() => {
				const snap: Partial<UIState> = {
					sidebarOpen: this.sidebarOpen,
					dark: this.dark,
					layout: this.layout,
					view: this.view
				};
				if (typeof localStorage !== 'undefined') {
					localStorage.setItem(LS_KEY, JSON.stringify(snap));
				}
			});
		});

		// Watch system theme changes when following system.
		if (typeof matchMedia !== 'undefined') {
			const mq = matchMedia('(prefers-color-scheme: dark)');
			mq.addEventListener?.('change', (e) => {
				this.systemDark = e.matches;
			});
		}
	}

	get effectiveDark(): boolean {
		return this.dark ?? this.systemDark;
	}

	toggleSidebar() {
		this.sidebarOpen = !this.sidebarOpen;
	}

	toggleDark() {
		this.dark = !this.effectiveDark;
	}

	toggleLayout() {
		this.layout = this.layout === 'grid' ? 'list' : 'grid';
	}

	setView(view: View, labelId: string | null = null) {
		this.view = view;
		this.activeLabelId = labelId;
		this.search = '';
	}

	/** Restore persisted UI preferences from a full device backup. */
	restoreState(state: { sidebarOpen?: boolean; dark?: boolean | null; layout?: Layout; view?: View }): void {
		if (typeof state.sidebarOpen === 'boolean') this.sidebarOpen = state.sidebarOpen;
		if (typeof state.dark === 'boolean' || state.dark === null) this.dark = state.dark;
		if (state.layout === 'grid' || state.layout === 'list') this.layout = state.layout;
		if (typeof state.view === 'string') this.view = state.view;
	}
}

export const uiStore = new UIStore();
