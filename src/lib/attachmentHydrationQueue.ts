/**
 * Small shared queue for attachment reads triggered by visible note cards.
 * It prevents a route from starting every Blob-to-data-URL conversion at once.
 */
export class AttachmentHydrationQueue {
	private pending: Array<{ id: string; generation: number }> = [];
	private queued = new Set<string>();
	private running = 0;
	private generation = 0;

	constructor(
		private readonly hydrate: (noteId: string) => Promise<void>,
		private readonly concurrency = 2
	) {}

	enqueue(noteId: string): void {
		if (!noteId || this.queued.has(noteId)) return;
		this.queued.add(noteId);
		this.pending.push({ id: noteId, generation: this.generation });
		this.drain();
	}

	/** Drop work that belongs to a dataset which is no longer active. */
	clear(): void {
		this.pending = [];
		this.queued.clear();
		this.generation++;
	}

	private drain(): void {
		while (this.running < this.concurrency && this.pending.length > 0) {
			const entry = this.pending.shift();
			if (!entry) continue;
			this.running++;
			void this.hydrate(entry.id).finally(() => {
				this.running--;
				if (entry.generation === this.generation) this.queued.delete(entry.id);
				this.drain();
			});
		}
	}
}
