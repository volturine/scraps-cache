export class SyncQuotaExceededError extends Error {
	constructor() {
		super('Sync account storage quota exceeded');
		this.name = 'SyncQuotaExceededError';
	}
}

export type CoordinatorNamespace = {
	idFromName: (name: string) => unknown;
	get: (id: any) => {
		fetch: (
			input: any,
			init?: any
		) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
	};
};

export type CoordinatorSyncInput = {
	accountId: string;
	cursor: number;
	uploads: unknown[];
	deletions: unknown[];
	downloadLimit: number;
	maxAccountBytes: number;
};

export async function syncThroughCoordinator(
	namespace: CoordinatorNamespace,
	input: CoordinatorSyncInput
): Promise<unknown> {
	const response = await namespace.get(namespace.idFromName(input.accountId)).fetch(
		new Request('https://coordinator/sync', {
			method: 'POST',
			body: JSON.stringify(input)
		})
	);
	if (response.status === 507) throw new SyncQuotaExceededError();
	if (!response.ok) throw new Error(`Account coordinator failed (${response.status})`);
	return response.json();
}
