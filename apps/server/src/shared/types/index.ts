export type {
	JwtPayload,
	PlacementEntry,
	Privilege,
	BanType,
	MatchStatus,
	ReportType,
	ReportStatus,
	ChallengeKind,
	ChallengeIssuance,
	ChallengeStrategy,
	RegisterPrivateDeps,
	LauncherIntegrityFailureReason,
} from '@bmp/types'

export interface DiscordTokenResponse {
	access_token: string
	token_type: string
	expires_in: number
	refresh_token: string
	scope: string
}

export interface DiscordUser {
	id: string
	username: string
	discriminator: string
	global_name: string | null
	avatar: string | null
}
