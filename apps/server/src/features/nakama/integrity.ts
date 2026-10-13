import type { ILauncherIntegrityRepository } from '../../contracts/ILauncherIntegrityRepository.js'
import * as launcherIntegrityGateway from '../../infrastructure/gateways/launcher-integrity.gateway.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { setNakamaIntegrity } from '../../infrastructure/nakama/integrity-sync.js'
import {
	type ChallengeSender,
	type IntegrityVerdict,
	type LauncherIntegrityService,
	createLauncherIntegrityService,
} from '../launcher-integrity/launcher-integrity.service.js'

// NotifyCode.CHALLENGE in nakama/src/notify.ts.
const NOTIFY_CHALLENGE = 100

interface NakamaIntegrityDeps {
	callNakamaRpc: typeof callNakamaRpc
	setIntegrity: (
		nakamaUserId: string,
		verdict: IntegrityVerdict,
	) => Promise<void>
	players: Pick<typeof playerGateway, 'findPlayerByNakamaUserId'>
	events: ILauncherIntegrityRepository
}

// Launcher-integrity challenges, keyed by Nakama user id, with Nakama as
// their transport. Challenges go out as CHALLENGE notifications, answers come
// in through /internal/nakama/integrity/answer, verdicts go to
// admin_integrity_set and a failed ranked-readiness check to
// admin_queue_cancel. A challenge for a player whose socket has closed ends
// their session here (Nakama has no session-end hook to tell us).
export function createNakamaIntegrityService(
	deps: NakamaIntegrityDeps,
): LauncherIntegrityService {
	let service: LauncherIntegrityService | null = null

	// Only challenges are sent; Nakama tells the player each verdict itself.
	const sendChallenge: ChallengeSender = async (userId, payload) => {
		if (payload.type !== 'issued') return
		const result = await deps.callNakamaRpc<{ online?: boolean }>(
			'admin_notify',
			{
				userId,
				code: NOTIFY_CHALLENGE,
				subject: 'challenge',
				content: payload,
			},
		)
		if (!result.ok)
			console.warn(`[nakama] Challenge for ${userId} not sent: ${result.error}`)
		else if (result.value.online === false) service?.clearSession(userId)
	}

	// The audit trail is keyed by Postgres player; a Nakama-only account with
	// no player row (its first sync failed) goes unrecorded.
	const repository: ILauncherIntegrityRepository = {
		async insertEvent(userId, kind, reason) {
			const player = await deps.players.findPlayerByNakamaUserId(userId)
			if (player) await deps.events.insertEvent(player.id, kind, reason)
		},
	}

	service = createLauncherIntegrityService({
		sendChallenge,
		repository,
		onVerdict: deps.setIntegrity,
	})
	service.onRankedReadinessFailed((userId, reason) => {
		void deps
			.callNakamaRpc('admin_queue_cancel', { userId, reason })
			.then((result) => {
				if (!result.ok)
					console.warn(
						`[nakama] Queue cancel for ${userId} not sent: ${result.error}`,
					)
			})
	})
	return service
}

export const nakamaIntegrityService = createNakamaIntegrityService({
	callNakamaRpc,
	setIntegrity: setNakamaIntegrity,
	players: playerGateway,
	events: launcherIntegrityGateway,
})
