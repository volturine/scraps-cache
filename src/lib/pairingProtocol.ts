export const PairingRole = {
	Existing: 'existing',
	New: 'new'
} as const;

export type PairingRole = (typeof PairingRole)[keyof typeof PairingRole];

export const PairingState = {
	Waiting: 'waiting',
	Matched: 'matched',
	Connected: 'connected',
	Expired: 'expired',
	NotFound: 'not-found'
} as const;

export type PairingState = (typeof PairingState)[keyof typeof PairingState];

export type PairingGrant = { ciphertext: string };

export type PairingPoll =
	| { state: typeof PairingState.Waiting; expiresAt: number }
	| { state: typeof PairingState.Matched; expiresAt: number; peerPublicKey: string }
	| {
			state: typeof PairingState.Connected;
			expiresAt: number;
			peerPublicKey: string;
			grant: PairingGrant;
	  }
	| { state: typeof PairingState.Expired | typeof PairingState.NotFound };

export function isPairingRole(value: unknown): value is PairingRole {
	return value === PairingRole.Existing || value === PairingRole.New;
}
