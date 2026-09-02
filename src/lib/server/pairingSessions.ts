import {
	PairingRole,
	PairingState,
	type PairingGrant,
	type PairingPoll
} from '$lib/pairingProtocol';
import { getDb, withTxn, type Db } from '$lib/server/db';

export type PairingParticipant = { id: string; expiresAt: number; role: PairingRole };

/** Anonymous 60-second meet-in-the-middle relay. It has no account, device, or user identity. */
export class PairingSessions {
	constructor(
		private readonly db: Db,
		private readonly createId: () => string = () => crypto.randomUUID(),
		private readonly maxSessions = 2_000
	) {}

	async start(
		codeTag: string,
		role: PairingRole,
		publicKey: string,
		now = Date.now()
	): Promise<PairingParticipant> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM pairing_sessions WHERE expires_at <= ?',
			args: [now]
		});
		const count = (await this.db.ops.execute('SELECT COUNT(*) AS count FROM pairing_sessions'))
			.rows[0] as unknown as { count: number };
		if (count.count >= this.maxSessions) {
			throw new Error('Pairing rendezvous is busy');
		}
		const id = this.createId();
		const expiresAt = now + 60_000;
		await withTxn(this.db.ops, async (tx) => {
			const claimed = await tx.execute({
				sql: `UPDATE pairing_sessions SET peer_id = ?
				 WHERE id = (
					SELECT id FROM pairing_sessions
					WHERE code_tag = ? AND role != ? AND peer_id IS NULL AND expires_at > ?
					ORDER BY expires_at ASC LIMIT 1
				 ) AND peer_id IS NULL
				 RETURNING id AS peerId`,
				args: [id, codeTag, role, now]
			});
			const peer = claimed.rows[0] as unknown as { peerId: string } | undefined;
			await tx.execute({
				sql: `INSERT INTO pairing_sessions(
					id, code_tag, role, public_key, peer_id, grant_ciphertext, expires_at
				) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
				args: [id, codeTag, role, publicKey, peer?.peerId ?? null, expiresAt]
			});
		});
		return { id, role, expiresAt };
	}

	async submitGrant(
		id: string,
		grant: PairingGrant,
		now = Date.now()
	): Promise<
		| {
				success: true;
		  }
		| { success: false; reason: 'not-found' | 'expired' | 'unmatched' | 'already-granted' }
	> {
		await this.db.ready;
		const claimed = await this.db.ops.execute({
			sql: `UPDATE pairing_sessions SET grant_ciphertext = ?
			 WHERE id = ? AND role = ? AND peer_id IS NOT NULL AND grant_ciphertext IS NULL AND expires_at > ?
			 RETURNING id AS granted`,
			args: [grant.ciphertext, id, PairingRole.Existing, now]
		});
		if (claimed.rows.length > 0) return { success: true };
		const existing = (
			await this.db.ops.execute({
				sql: `SELECT role, peer_id AS peerId, grant_ciphertext AS grantCiphertext,
					expires_at AS expiresAt FROM pairing_sessions WHERE id = ?`,
				args: [id]
			})
		).rows[0] as unknown as
			| {
					role: string;
					peerId: string | null;
					grantCiphertext: string | null;
					expiresAt: number;
			  }
			| undefined;
		if (!existing) return { success: false, reason: 'not-found' };
		if (existing.expiresAt <= now) {
			await this.db.ops.execute({
				sql: 'DELETE FROM pairing_sessions WHERE id = ?',
				args: [id]
			});
			return { success: false, reason: 'expired' };
		}
		if (existing.role !== PairingRole.Existing || !existing.peerId) {
			return { success: false, reason: 'unmatched' };
		}
		return { success: false, reason: 'already-granted' };
	}

	async poll(id: string, now = Date.now()): Promise<PairingPoll> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT s.role AS role, s.expires_at AS expiresAt, s.peer_id AS peerId,
				p.public_key AS peerPublicKey, p.grant_ciphertext AS grantCiphertext
			 FROM pairing_sessions s
			 LEFT JOIN pairing_sessions p ON p.id = s.peer_id
			 WHERE s.id = ?`,
			args: [id]
		});
		const session = result.rows[0] as unknown as
			| {
					role: PairingRole;
					expiresAt: number;
					peerId: string | null;
					peerPublicKey: string | null;
					grantCiphertext: string | null;
			  }
			| undefined;
		if (!session) return { state: PairingState.NotFound };
		if (session.expiresAt <= now) {
			await this.db.ops.execute({
				sql: 'DELETE FROM pairing_sessions WHERE id = ?',
				args: [id]
			});
			return { state: PairingState.Expired };
		}
		if (!session.peerPublicKey) {
			return session.peerId
				? { state: PairingState.Expired }
				: { state: PairingState.Waiting, expiresAt: session.expiresAt };
		}
		if (session.role === PairingRole.New && session.grantCiphertext) {
			return {
				state: PairingState.Connected,
				expiresAt: session.expiresAt,
				peerPublicKey: session.peerPublicKey,
				grant: { ciphertext: session.grantCiphertext }
			};
		}
		return {
			state: PairingState.Matched,
			expiresAt: session.expiresAt,
			peerPublicKey: session.peerPublicKey
		};
	}

	async prune(now = Date.now()): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM pairing_sessions WHERE expires_at <= ?',
			args: [now]
		});
	}
}

let singleton: PairingSessions | undefined;

export function getPairingSessions(): PairingSessions {
	singleton ??= new PairingSessions(getDb());
	return singleton;
}
