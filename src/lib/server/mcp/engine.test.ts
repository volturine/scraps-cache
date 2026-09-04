import { describe, expect, it } from 'vitest';
import { McpSession, type McpStorage } from './engine';
import { handleJsonRpcMessage, type JsonRpcResponse } from './protocol';
import { createSyncIdentity, encryptSyncPayload } from '$lib/syncPairing';
import { sha256 } from '$lib/syncHash';

class MockStorage implements McpStorage {
	envelopes: Array<{ seq: number; id: string; slot: string; ciphertext: string }> = [];

	async sync(
		accountId: string,
		cursor: number,
		uploads: Array<{ id: string; slot: string; ciphertext: string; expectedId?: string | null }>,
		deletions: Array<{ id: string; slot: string }>,
		downloadLimit: number
	) {
		for (const upload of uploads) {
			const seq = this.envelopes.length + 1;
			const existingIndex = this.envelopes.findIndex((e) => e.slot === upload.slot);
			if (existingIndex >= 0) {
				this.envelopes[existingIndex] = {
					seq,
					id: upload.id,
					slot: upload.slot,
					ciphertext: upload.ciphertext
				};
			} else {
				this.envelopes.push({
					seq,
					id: upload.id,
					slot: upload.slot,
					ciphertext: upload.ciphertext
				});
			}
		}

		return {
			cursor: this.envelopes.length,
			envelopes: this.envelopes.slice(cursor),
			conflicts: [],
			hasMore: false,
			reset: false,
			writesAccepted: true
		};
	}
}

describe('mcp session & engine', () => {
	it('creates notes, searches, reads checklists, and updates notes', async () => {
		const identity = createSyncIdentity();
		const storage = new MockStorage();

		// Pre-populate with a note in storage
		const initialNote = {
			id: 'note-1',
			title: 'Groceries',
			body: '- [ ] Milk\n- [ ] Eggs\nRemember bags!',
			color: 'default' as const,
			pinned: false,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: Date.now() - 1000,
			updatedAt: Date.now() - 1000,
			reminder: null,
			labels: ['lbl-1']
		};
		const initialLabel = {
			id: 'lbl-1',
			name: 'Shopping',
			createdAt: Date.now() - 2000,
			updatedAt: Date.now() - 2000
		};

		const noteSlot = await sha256(`${identity.syncKey}\u0000note:note-1`);
		const labelSlot = await sha256(`${identity.syncKey}\u0000label:lbl-1`);

		storage.envelopes.push({
			seq: 1,
			id: 'env-lbl',
			slot: labelSlot,
			ciphertext: encryptSyncPayload(identity.syncKey, { kind: 'label', value: initialLabel })
		});
		storage.envelopes.push({
			seq: 2,
			id: 'env-note',
			slot: noteSlot,
			ciphertext: encryptSyncPayload(identity.syncKey, { kind: 'note', value: initialNote })
		});

		const session = new McpSession(identity.accountId, identity.syncKey, storage);

		// 1. Search notes
		const searchRes = await session.searchNotes({ query: 'milk' });
		expect(searchRes.notes.length).toBe(1);
		expect(searchRes.notes[0].title).toBe('Groceries');
		expect(searchRes.notes[0].labels).toContain('Shopping');

		// 2. Read note
		const noteDetails = await session.readNote({ id: 'note-1' });
		expect(noteDetails.title).toBe('Groceries');
		expect(noteDetails.checklistItems.length).toBe(2);
		expect(noteDetails.checklistItems[0].text).toBe('Milk');
		expect(noteDetails.checklistItems[0].completed).toBe(false);

		// 3. Update note: toggle Milk to completed and append bread
		await session.updateNote({
			id: 'note-1',
			toggleChecklistItems: ['Milk'],
			appendChecklistItems: ['Bread']
		});

		const updatedDetails = await session.readNote({ id: 'note-1' });
		expect(updatedDetails.checklistItems.length).toBe(3);
		expect(updatedDetails.checklistItems[0].text).toBe('Milk');
		expect(updatedDetails.checklistItems[0].completed).toBe(true);
		expect(updatedDetails.checklistItems[2].text).toBe('Bread');
		expect(updatedDetails.checklistItems[2].completed).toBe(false);

		// 4. Create new note with label
		const created = await session.createNote({
			title: 'Idea Note',
			body: 'Build cool stuff',
			labels: ['Project', 'Shopping'],
			pinned: true
		});
		expect(created.success).toBe(true);
		expect(created.note.title).toBe('Idea Note');
		expect(created.note.labels).toContain('Project');
		expect(created.note.labels).toContain('Shopping');

		// 5. List labels
		const labelsList = await session.listLabels();
		expect(labelsList.labels.map((l) => l.name)).toContain('Shopping');
		expect(labelsList.labels.map((l) => l.name)).toContain('Project');
	});

	it('handles JSON-RPC protocol messages', async () => {
		const identity = createSyncIdentity();
		const storage = new MockStorage();
		const session = new McpSession(identity.accountId, identity.syncKey, storage);

		// initialize
		const initResp = (await handleJsonRpcMessage(session, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2024-11-05' }
		})) as JsonRpcResponse;
		expect(initResp?.id).toBe(1);
		expect(initResp?.result).toHaveProperty('protocolVersion', '2024-11-05');
		expect(initResp?.result).toHaveProperty('capabilities');

		// ping
		const pingResp = (await handleJsonRpcMessage(session, {
			jsonrpc: '2.0',
			id: 2,
			method: 'ping'
		})) as JsonRpcResponse;
		expect(pingResp?.id).toBe(2);
		expect(pingResp?.result).toEqual({});

		// tools/list
		const toolsResp = (await handleJsonRpcMessage(session, {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/list'
		})) as JsonRpcResponse;
		expect(toolsResp?.id).toBe(3);
		const toolsResult = toolsResp?.result as { tools: Array<{ name: string }> };
		expect(toolsResult.tools.map((t) => t.name)).toContain('search_notes');
		expect(toolsResult.tools.map((t) => t.name)).toContain('create_note');

		// tools/call create_note
		const callResp = (await handleJsonRpcMessage(session, {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'create_note',
				arguments: {
					title: 'Testing Call',
					body: 'Call body'
				}
			}
		})) as JsonRpcResponse;
		expect(callResp?.id).toBe(4);
		const callContent = (callResp?.result as { content: Array<{ text: string }> }).content;
		expect(callContent[0].text).toContain('Testing Call');
	});
});
