import { describe, expect, it } from 'vitest';
import { AttachmentHydrationQueue } from './attachmentHydrationQueue';

describe('AttachmentHydrationQueue', () => {
	it('limits visible attachment hydration and ignores duplicate requests', async () => {
		const started: string[] = [];
		const release = new Map<string, () => void>();
		const queue = new AttachmentHydrationQueue(
			(id) =>
				new Promise<void>((resolve) => {
					started.push(id);
					release.set(id, resolve);
				}),
			2
		);

		queue.enqueue('a');
		queue.enqueue('b');
		queue.enqueue('a');
		queue.enqueue('c');
		expect(started).toEqual(['a', 'b']);

		release.get('a')?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(started).toEqual(['a', 'b', 'c']);
	});

	it('drops queued work when the active dataset changes', async () => {
		const started: string[] = [];
		let release!: () => void;
		const queue = new AttachmentHydrationQueue(
			(id) =>
				new Promise<void>((resolve) => {
					started.push(id);
					release = resolve;
				}),
			1
		);

		queue.enqueue('old-running');
		queue.enqueue('old-queued');
		queue.clear();
		queue.enqueue('old-running');
		release();
		await Promise.resolve();
		await Promise.resolve();

		expect(started).toEqual(['old-running', 'old-running']);
	});
});
