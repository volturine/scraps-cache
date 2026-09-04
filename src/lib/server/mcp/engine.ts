import {
	encryptSyncPayload,
	decryptSyncPayload,
	identityFromSyncKey,
	randomOpaqueId
} from '$lib/syncPairing';
import { parseBody, parseCheckLine, formatCheckLine } from '$lib/checklistBody';
import { sha256 } from '$lib/syncHash';
import { getSyncStore } from '$lib/server/syncStore';
import type { Note, Label, NoteColor } from '$lib/types';
import type { SyncRecordPayload } from '$lib/syncRecords';

export type McpStorage = {
	sync(
		accountId: string,
		cursor: number,
		uploads: Array<{ id: string; slot: string; ciphertext: string; expectedId?: string | null }>,
		deletions: Array<{ id: string; slot: string }>,
		downloadLimit: number
	): Promise<{
		cursor: number;
		envelopes: Array<{ seq: number; id: string; slot: string; ciphertext: string }>;
		conflicts: Array<{ seq: number; id: string; slot: string; ciphertext: string }>;
		hasMore: boolean;
		reset: boolean;
		writesAccepted: boolean;
	}>;
};

export type McpToolDefinition = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

export const MCP_TOOLS: McpToolDefinition[] = [
	{
		name: 'search_notes',
		description: 'Search existing notes by text query, or filter by label and pinned status.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Search string matching note title or text body (case-insensitive).'
				},
				label: {
					type: 'string',
					description: 'Filter notes by label name (case-insensitive).'
				},
				pinnedOnly: {
					type: 'boolean',
					description: 'If true, returns only pinned notes.'
				},
				limit: {
					type: 'number',
					description: 'Maximum number of notes to return (default 20, max 50).'
				}
			}
		}
	},
	{
		name: 'list_recent_notes',
		description: 'List the most recently updated notes.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: {
					type: 'number',
					description: 'Maximum number of notes to return (default 10, max 50).'
				}
			}
		}
	},
	{
		name: 'read_note',
		description:
			'Retrieve the full content of a note by its ID, including full text, parsed checklist items, labels, and timestamps.',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: 'The unique ID of the note to read.'
				}
			},
			required: ['id']
		}
	},
	{
		name: 'create_note',
		description:
			'Create a new note in Scraps Cache with optional body text, checklist items, labels, and color.',
		inputSchema: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'The note title.'
				},
				body: {
					type: 'string',
					description: 'Plain text note body content.'
				},
				checklist: {
					type: 'array',
					items: { type: 'string' },
					description: 'Checklist items to include as unchecked tasks.'
				},
				labels: {
					type: 'array',
					items: { type: 'string' },
					description: 'Names of labels/tags to attach to the note.'
				},
				pinned: {
					type: 'boolean',
					description: 'Whether to pin the note to the top.'
				},
				color: {
					type: 'string',
					description:
						'Color name: default, red, orange, yellow, green, teal, blue, darkblue, purple, pink, brown, gray.'
				}
			}
		}
	},
	{
		name: 'update_note',
		description:
			'Update an existing note: change title, append body text, append checklist items, or toggle checklist items (done/undone).',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: 'The ID of the note to update.'
				},
				title: {
					type: 'string',
					description: 'Optional updated title.'
				},
				appendBody: {
					type: 'string',
					description: 'Text to append to the end of the note.'
				},
				appendChecklistItems: {
					type: 'array',
					items: { type: 'string' },
					description: 'New checklist items to append to the note.'
				},
				toggleChecklistItems: {
					type: 'array',
					items: { type: 'string' },
					description: 'List of checklist item texts to toggle (from [ ] to [x] or [x] to [ ]).'
				},
				pinned: {
					type: 'boolean',
					description: 'Whether note is pinned.'
				},
				archived: {
					type: 'boolean',
					description: 'Whether note is archived.'
				}
			},
			required: ['id']
		}
	},
	{
		name: 'list_labels',
		description: 'List all existing note labels/tags.',
		inputSchema: {
			type: 'object',
			properties: {}
		}
	}
];

export class McpSession {
	readonly accountId: string;
	readonly syncKey: string;
	private readonly storage: McpStorage;

	private notes = new Map<string, Note>();
	private labels = new Map<string, Label>();
	private syncedSlots = new Map<string, { id: string; slot: string }>();

	private cursor = 0;
	private isHydrated = false;
	lastActiveAt = Date.now();

	private sseListeners = new Set<(event: string, data: unknown) => void>();

	constructor(accountId: string, syncKey: string, storage?: McpStorage) {
		this.accountId = accountId;
		this.syncKey = syncKey;
		this.storage = storage ?? (getSyncStore() as unknown as McpStorage);
	}

	touch(): void {
		this.lastActiveAt = Date.now();
	}

	addSseListener(listener: (event: string, data: unknown) => void): () => void {
		this.sseListeners.add(listener);
		return () => {
			this.sseListeners.delete(listener);
		};
	}

	broadcast(event: string, data: unknown): void {
		for (const listener of this.sseListeners) {
			try {
				listener(event, data);
			} catch {
				// Ignore dead listener
			}
		}
	}

	async ensureHydrated(): Promise<void> {
		this.touch();
		if (this.isHydrated) return;

		let hasMore = true;
		while (hasMore) {
			const result = await this.storage.sync(this.accountId, this.cursor, [], [], 100);
			if (result.reset) {
				this.notes.clear();
				this.labels.clear();
				this.syncedSlots.clear();
				this.cursor = 0;
			}
			for (const envelope of result.envelopes) {
				try {
					const payload = decryptSyncPayload(
						this.syncKey,
						envelope.ciphertext
					) as SyncRecordPayload;
					if (payload && typeof payload === 'object') {
						if (payload.kind === 'note') {
							this.notes.set(payload.value.id, payload.value as Note);
							this.syncedSlots.set(`note:${payload.value.id}`, {
								id: envelope.id,
								slot: envelope.slot
							});
						} else if (payload.kind === 'note-tombstone') {
							this.notes.delete(payload.id);
							this.syncedSlots.set(`note:${payload.id}`, {
								id: envelope.id,
								slot: envelope.slot
							});
						} else if (payload.kind === 'label') {
							this.labels.set(payload.value.id, payload.value);
							this.syncedSlots.set(`label:${payload.value.id}`, {
								id: envelope.id,
								slot: envelope.slot
							});
						} else if (payload.kind === 'label-tombstone') {
							this.labels.delete(payload.id);
							this.syncedSlots.set(`label:${payload.id}`, {
								id: envelope.id,
								slot: envelope.slot
							});
						}
					}
				} catch {
					// Ignore undecryptable / foreign envelope
				}
			}
			this.cursor = result.cursor;
			hasMore = result.hasMore;
		}

		this.isHydrated = true;
	}

	private getLabelNames(labelIds: string[] = []): string[] {
		return labelIds
			.map((id) => this.labels.get(id)?.name)
			.filter((name): name is string => typeof name === 'string');
	}

	async searchNotes(args: {
		query?: string;
		label?: string;
		pinnedOnly?: boolean;
		limit?: number;
	}) {
		await this.ensureHydrated();
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
		const query = args.query?.trim().toLowerCase();

		let labelIdFilter: string | undefined;
		if (args.label) {
			const target = args.label.trim().toLowerCase();
			for (const [id, lbl] of this.labels.entries()) {
				if (lbl.name.toLowerCase() === target) {
					labelIdFilter = id;
					break;
				}
			}
			if (!labelIdFilter) {
				return { notes: [] };
			}
		}

		const results = [];
		for (const note of this.notes.values()) {
			if (note.trashed) continue;
			if (args.pinnedOnly && !note.pinned) continue;
			if (labelIdFilter && !note.labels?.includes(labelIdFilter)) continue;

			if (query) {
				const titleMatch = note.title.toLowerCase().includes(query);
				const bodyMatch = note.body.toLowerCase().includes(query);
				if (!titleMatch && !bodyMatch) continue;
			}

			const preview =
				note.body.length > 200 ? `${note.body.slice(0, 200).trim()}...` : note.body.trim();

			results.push({
				id: note.id,
				title: note.title || 'Untitled',
				preview,
				labels: this.getLabelNames(note.labels),
				pinned: note.pinned,
				updatedAt: new Date(note.updatedAt).toISOString()
			});

			if (results.length >= limit) break;
		}

		return { notes: results };
	}

	async listRecentNotes(args: { limit?: number }) {
		await this.ensureHydrated();
		const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

		const activeNotes = [...this.notes.values()]
			.filter((n) => !n.trashed)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit);

		return {
			notes: activeNotes.map((note) => ({
				id: note.id,
				title: note.title || 'Untitled',
				preview: note.body.length > 200 ? `${note.body.slice(0, 200).trim()}...` : note.body.trim(),
				labels: this.getLabelNames(note.labels),
				pinned: note.pinned,
				updatedAt: new Date(note.updatedAt).toISOString()
			}))
		};
	}

	async readNote(args: { id: string }) {
		await this.ensureHydrated();
		const note = this.notes.get(args.id);
		if (!note || note.trashed) {
			throw new Error(`Note with id "${args.id}" not found`);
		}

		const segments = parseBody(note.body);
		const checklistItems: Array<{ text: string; completed: boolean; lineIndex: number }> = [];
		for (const seg of segments) {
			if (seg.type === 'check') {
				checklistItems.push({
					text: seg.text,
					completed: seg.checked,
					lineIndex: seg.lineIndex
				});
			}
		}

		return {
			id: note.id,
			title: note.title,
			body: note.body,
			checklistItems,
			labels: this.getLabelNames(note.labels),
			color: note.color,
			pinned: note.pinned,
			archived: note.archived,
			createdAt: new Date(note.createdAt).toISOString(),
			updatedAt: new Date(note.updatedAt).toISOString()
		};
	}

	async createNote(args: {
		title?: string;
		body?: string;
		checklist?: string[];
		labels?: string[];
		pinned?: boolean;
		color?: string;
	}) {
		await this.ensureHydrated();
		const now = Date.now();
		const uploads: Array<{
			id: string;
			slot: string;
			ciphertext: string;
			expectedId?: string | null;
		}> = [];

		// Handle labels: find existing or create new
		const labelIds: string[] = [];
		if (args.labels && args.labels.length > 0) {
			for (const rawName of args.labels) {
				const trimmed = rawName.trim();
				if (!trimmed) continue;
				let found: Label | undefined;
				for (const lbl of this.labels.values()) {
					if (lbl.name.toLowerCase() === trimmed.toLowerCase()) {
						found = lbl;
						break;
					}
				}
				if (found) {
					labelIds.push(found.id);
				} else {
					const newLabelId = randomOpaqueId();
					const newLabel: Label = {
						id: newLabelId,
						name: trimmed,
						createdAt: now,
						updatedAt: now
					};
					this.labels.set(newLabelId, newLabel);
					labelIds.push(newLabelId);

					const labelSlot = await sha256(`${this.syncKey}\u0000label:${newLabelId}`);
					const labelCiphertext = encryptSyncPayload(this.syncKey, {
						kind: 'label',
						value: newLabel
					});
					const labelUploadId = randomOpaqueId();
					uploads.push({
						id: labelUploadId,
						slot: labelSlot,
						ciphertext: labelCiphertext,
						expectedId: null
					});
					this.syncedSlots.set(`label:${newLabelId}`, { id: labelUploadId, slot: labelSlot });
				}
			}
		}

		// Build note body
		let fullBody = args.body?.trim() ?? '';
		if (args.checklist && args.checklist.length > 0) {
			const checklistText = args.checklist
				.map((item) => formatCheckLine(0, false, item.trim()))
				.join('\n');
			if (fullBody) {
				fullBody = `${fullBody}\n\n${checklistText}`;
			} else {
				fullBody = checklistText;
			}
		}

		const validColors: NoteColor[] = [
			'default',
			'red',
			'orange',
			'yellow',
			'green',
			'teal',
			'blue',
			'darkblue',
			'purple',
			'pink',
			'brown',
			'gray'
		];
		const noteColor: NoteColor =
			args.color && validColors.includes(args.color as NoteColor)
				? (args.color as NoteColor)
				: 'default';

		const noteId = randomOpaqueId();
		const note: Note = {
			id: noteId,
			title: args.title?.trim() ?? '',
			body: fullBody,
			color: noteColor,
			pinned: !!args.pinned,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: now,
			updatedAt: now,
			reminder: null,
			labels: labelIds
		};

		this.notes.set(noteId, note);

		const noteSlot = await sha256(`${this.syncKey}\u0000note:${noteId}`);
		const noteCiphertext = encryptSyncPayload(this.syncKey, {
			kind: 'note',
			value: note
		});
		const noteUploadId = randomOpaqueId();
		uploads.push({
			id: noteUploadId,
			slot: noteSlot,
			ciphertext: noteCiphertext,
			expectedId: null
		});
		this.syncedSlots.set(`note:${noteId}`, { id: noteUploadId, slot: noteSlot });

		await this.storage.sync(this.accountId, this.cursor, uploads, [], 100);

		return {
			success: true,
			note: {
				id: note.id,
				title: note.title,
				body: note.body,
				labels: this.getLabelNames(note.labels),
				pinned: note.pinned,
				color: note.color,
				createdAt: new Date(note.createdAt).toISOString()
			}
		};
	}

	async updateNote(args: {
		id: string;
		title?: string;
		appendBody?: string;
		appendChecklistItems?: string[];
		toggleChecklistItems?: string[];
		pinned?: boolean;
		archived?: boolean;
	}) {
		await this.ensureHydrated();
		const note = this.notes.get(args.id);
		if (!note || note.trashed) {
			throw new Error(`Note with id "${args.id}" not found`);
		}

		if (args.title !== undefined) {
			note.title = args.title.trim();
		}

		if (args.appendBody) {
			const toAppend = args.appendBody.trim();
			if (toAppend) {
				note.body = note.body ? `${note.body}\n\n${toAppend}` : toAppend;
			}
		}

		if (args.appendChecklistItems && args.appendChecklistItems.length > 0) {
			const itemsText = args.appendChecklistItems
				.map((item) => formatCheckLine(0, false, item.trim()))
				.join('\n');
			if (note.body) {
				note.body = note.body.endsWith('\n')
					? `${note.body}${itemsText}`
					: `${note.body}\n${itemsText}`;
			} else {
				note.body = itemsText;
			}
		}

		if (args.toggleChecklistItems && args.toggleChecklistItems.length > 0) {
			const targets = args.toggleChecklistItems.map((t) => t.trim().toLowerCase());
			const lines = note.body.split('\n');
			const updatedLines = lines.map((line) => {
				const check = parseCheckLine(line);
				if (check) {
					const checkLower = check.text.trim().toLowerCase();
					const match = targets.some((t) => checkLower === t || checkLower.includes(t));
					if (match) {
						return formatCheckLine(check.indent, !check.checked, check.text);
					}
				}
				return line;
			});
			note.body = updatedLines.join('\n');
		}

		if (args.pinned !== undefined) {
			note.pinned = args.pinned;
		}

		if (args.archived !== undefined) {
			note.archived = args.archived;
		}

		note.updatedAt = Date.now();

		const noteSlot = await sha256(`${this.syncKey}\u0000note:${note.id}`);
		const noteCiphertext = encryptSyncPayload(this.syncKey, {
			kind: 'note',
			value: note
		});
		const priorSlot = this.syncedSlots.get(`note:${note.id}`);
		const uploadId = randomOpaqueId();
		const upload = {
			id: uploadId,
			slot: noteSlot,
			ciphertext: noteCiphertext,
			expectedId: priorSlot?.id ?? null
		};

		await this.storage.sync(this.accountId, this.cursor, [upload], [], 100);
		this.syncedSlots.set(`note:${note.id}`, { id: uploadId, slot: noteSlot });

		return {
			success: true,
			note: {
				id: note.id,
				title: note.title,
				body: note.body,
				pinned: note.pinned,
				archived: note.archived,
				updatedAt: new Date(note.updatedAt).toISOString()
			}
		};
	}

	async listLabels() {
		await this.ensureHydrated();
		const result = [...this.labels.values()].map((label) => ({
			id: label.id,
			name: label.name
		}));
		return { labels: result };
	}

	async listResources() {
		await this.ensureHydrated();
		const activeNotes = [...this.notes.values()]
			.filter((n) => !n.trashed)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 50);

		return {
			resources: activeNotes.map((note) => ({
				uri: `note://${note.id}`,
				name: note.title || 'Untitled Note',
				description: note.body ? note.body.slice(0, 100) : '',
				mimeType: 'text/markdown'
			}))
		};
	}

	async readResource(uri: string) {
		await this.ensureHydrated();
		const noteId = uri.replace(/^note:\/\//, '');
		const note = this.notes.get(noteId);
		if (!note || note.trashed) {
			throw new Error(`Resource "${uri}" not found`);
		}
		const title = note.title ? `# ${note.title}\n\n` : '';
		const markdown = `${title}${note.body}`;
		return {
			contents: [
				{
					uri,
					mimeType: 'text/markdown',
					text: markdown
				}
			]
		};
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		this.touch();
		switch (name) {
			case 'search_notes':
				return this.searchNotes(
					args as { query?: string; label?: string; pinnedOnly?: boolean; limit?: number }
				);
			case 'list_recent_notes':
				return this.listRecentNotes(args as { limit?: number });
			case 'read_note':
				return this.readNote(args as { id: string });
			case 'create_note':
				return this.createNote(
					args as {
						title?: string;
						body?: string;
						checklist?: string[];
						labels?: string[];
						pinned?: boolean;
						color?: string;
					}
				);
			case 'update_note':
				return this.updateNote(
					args as {
						id: string;
						title?: string;
						appendBody?: string;
						appendChecklistItems?: string[];
						toggleChecklistItems?: string[];
						pinned?: boolean;
						archived?: boolean;
					}
				);
			case 'list_labels':
				return this.listLabels();
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}
}
