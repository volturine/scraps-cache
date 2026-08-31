import { randomUUID } from 'crypto';
import {
	PairingRole,
	PairingState,
	type PairingGrant,
	type PairingPoll
} from '$lib/pairingProtocol';

export type PairingParticipant = { id: string; expiresAt: number; role: PairingRole };

type Session = PairingParticipant & {
	codeTag: string;
	publicKey: string;
	peerId: string | null;
	grant: PairingGrant | null;
};

/** Anonymous 60-second meet-in-the-middle relay. It has no account, device, or user identity. */
export class PairingSessions {
	private readonly sessions = new Map<string, Session>();
	constructor(
		private readonly createId: () => string = randomUUID,
		private readonly maxSessions = 2_000
	) {}

	start(
		codeTag: string,
		role: PairingRole,
		publicKey: string,
		now = Date.now()
	): PairingParticipant {
		this.prune(now);
		if (this.sessions.size >= this.maxSessions) {
			throw new Error('Pairing rendezvous is busy');
		}
		const id = this.createId(),
			expiresAt = now + 60_000;
		const session: Session = { id, role, codeTag, publicKey, expiresAt, peerId: null, grant: null };
		const peer = [...this.sessions.values()].find(
			(candidate) =>
				candidate.codeTag === codeTag && candidate.role !== role && candidate.peerId === null
		);
		if (peer) {
			peer.peerId = id;
			session.peerId = peer.id;
		}
		this.sessions.set(id, session);
		return { id, role, expiresAt };
	}

	submitGrant(
		id: string,
		grant: PairingGrant,
		now = Date.now()
	):
		| {
				success: true;
		  }
		| { success: false; reason: 'not-found' | 'expired' | 'unmatched' | 'already-granted' } {
		const session = this.sessions.get(id);
		if (!session) return { success: false, reason: 'not-found' };
		if (session.expiresAt <= now) {
			this.remove(session);
			return { success: false, reason: 'expired' };
		}
		if (session.role !== PairingRole.Existing || !session.peerId)
			return { success: false, reason: 'unmatched' };
		if (session.grant) return { success: false, reason: 'already-granted' };
		session.grant = grant;
		return { success: true };
	}

	poll(id: string, now = Date.now()): PairingPoll {
		const session = this.sessions.get(id);
		if (!session) return { state: PairingState.NotFound };
		if (session.expiresAt <= now) {
			this.remove(session);
			return { state: PairingState.Expired };
		}
		const peer = session.peerId ? this.sessions.get(session.peerId) : null;
		if (!peer)
			return session.peerId
				? { state: PairingState.Expired }
				: { state: PairingState.Waiting, expiresAt: session.expiresAt };
		if (session.role === PairingRole.New && peer.grant)
			return {
				state: PairingState.Connected,
				expiresAt: session.expiresAt,
				peerPublicKey: peer.publicKey,
				grant: peer.grant
			};
		return {
			state: PairingState.Matched,
			expiresAt: session.expiresAt,
			peerPublicKey: peer.publicKey
		};
	}

	private remove(session: Session): void {
		this.sessions.delete(session.id);
	}
	private prune(now: number): void {
		for (const session of [...this.sessions.values()])
			if (session.expiresAt <= now) this.remove(session);
	}
}
export const pairingSessions = new PairingSessions();
