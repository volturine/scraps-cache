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

function applyDocumentTheme(dark: boolean) {
	if (typeof document === 'undefined' || !document.body) return;
	const bg = dark ? '#1a1a1a' : '#ffffff';
	const root = document.documentElement;
	root.classList.toggle('dark', dark);
	root.style.colorScheme = dark ? 'dark' : 'light';
	root.style.backgroundColor = bg;
	document.body.style.backgroundColor = bg;
}

const LS_KEY = 'gkc-ui-state';

const VIEWS: readonly View[] = ['notes', 'kanban', 'reminders', 'archive', 'trash', 'label'];

function isView(value: unknown): value is View {
	return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

const CLOSED_VIEWS: Record<View, boolean> = {
	notes: false,
	kanban: false,
	reminders: false,
	archive: false,
	trash: false,
	label: false
};

export class UIStore {
	#sidebarOpen = $state(true);
	/** Explicit preference. `null` means follow the operating system. */
	#dark = $state<boolean | null>(null);
	private systemDark = $state(prefersDark());
	#layout = $state<Layout>('grid');
	#view = $state<View>('notes');
	activeLabelId = $state<string | null>(null);
	// Ephemeral route-feedback state; never persisted across a reload.
	pendingPath = $state<string | null>(null);
	/** What the search input shows; updates on every keystroke. */
	searchInput = $state('');
	/** Committed search value; lags the input by a short debounce. */
	search = $state('');
	settingsOpen = $state(false);
	/** Views that have been shown this session and should stay mounted. */
	opened = $state<Record<View, boolean>>({ ...CLOSED_VIEWS });

	#persistable = false;
	#searchTimer: ReturnType<typeof setTimeout> | null = null;
	viewChangeHandler: (() => void) | null = null;

	get sidebarOpen() {
		return this.#sidebarOpen;
	}
	set sidebarOpen(value: boolean) {
		this.#sidebarOpen = value;
		this.#persist();
	}

	get dark() {
		return this.#dark;
	}
	set dark(value: boolean | null) {
		this.#dark = value;
		this.#persist();
		applyDocumentTheme(this.effectiveDark);
	}

	get layout() {
		return this.#layout;
	}
	set layout(value: Layout) {
		this.#layout = value;
		this.#persist();
	}

	get view() {
		return this.#view;
	}
	set view(value: View) {
		this.#view = value;
		this.#open(value);
		this.#persist();
	}

	setSearchInput(value: string) {
		if (this.#searchTimer !== null) {
			clearTimeout(this.#searchTimer);
			this.#searchTimer = null;
		}
		this.searchInput = value;
		if (!value.trim()) {
			this.search = '';
			return;
		}
		this.#searchTimer = setTimeout(() => {
			this.#searchTimer = null;
			this.search = this.searchInput;
		}, 120);
	}

	clearSearch() {
		this.setSearchInput('');
	}

	constructor() {
		if (typeof localStorage !== 'undefined') {
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (raw) {
					const parsed = JSON.parse(raw) as Partial<UIState>;
					if (typeof parsed.sidebarOpen === 'boolean') this.#sidebarOpen = parsed.sidebarOpen;
					if (typeof parsed.dark === 'boolean' || parsed.dark === null) this.#dark = parsed.dark;
					if (parsed.layout === 'grid' || parsed.layout === 'list') this.#layout = parsed.layout;
					if (isView(parsed.view)) this.#view = parsed.view;
				}
			} catch {
				/* ignore */
			}
		}
		this.#open(this.#view);
		this.#persistable = true;
		applyDocumentTheme(this.effectiveDark);

		// Watch system theme changes when following system.
		if (typeof matchMedia !== 'undefined') {
			const mq = matchMedia('(prefers-color-scheme: dark)');
			mq.addEventListener?.('change', (e) => {
				this.systemDark = e.matches;
				if (this.#dark === null) applyDocumentTheme(e.matches);
			});
		}
	}

	#open(view: View) {
		if (this.opened[view]) return;
		this.opened = { ...this.opened, [view]: true };
	}

	#persist() {
		if (!this.#persistable || typeof localStorage === 'undefined') return;
		const snap: Partial<UIState> = {
			sidebarOpen: this.#sidebarOpen,
			dark: this.#dark,
			layout: this.#layout,
			view: this.#view
		};
		localStorage.setItem(LS_KEY, JSON.stringify(snap));
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
		this.clearSearch();
		this.viewChangeHandler?.();
	}

	/** Restore persisted UI preferences from a full device backup. */
	restoreState(state: {
		sidebarOpen?: boolean;
		dark?: boolean | null;
		layout?: Layout;
		view?: View;
	}): void {
		if (typeof state.sidebarOpen === 'boolean') this.sidebarOpen = state.sidebarOpen;
		if (typeof state.dark === 'boolean' || state.dark === null) this.dark = state.dark;
		if (state.layout === 'grid' || state.layout === 'list') this.layout = state.layout;
		if (isView(state.view)) this.view = state.view;
	}
}

export const uiStore = new UIStore();
