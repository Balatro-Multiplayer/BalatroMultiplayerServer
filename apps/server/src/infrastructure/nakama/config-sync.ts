import type { AppConfig } from '../../state/config.js'
import { callNakamaRpc, isNakamaAdminEnabled } from './admin-client.js'

const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000]

// Whether ranked needs a launcher-integrity verdict: set at boot, once it is
// known whether a challenge strategy was registered.
let integrityEnforced = false

export function setIntegrityEnforced(enforced: boolean): void {
	integrityEnforced = enforced
}

// The server switches Nakama enforces (nakama/src/config.ts ServerConfig).
export function nakamaConfigOf(config: AppConfig): Record<string, unknown> {
	return {
		tosVersion: config.tosVersion,
		chatEnabled: config.chatEnabled,
		rankedEnabled: config.rankedEnabled,
		casualQueueEnabled: config.casualQueueEnabled,
		lobbyCreationEnabled: config.lobbyCreationEnabled,
		testingMode: config.testingMode === true,
		integrityEnforced,
		chatAllowlist: [...config.chatAllowlist],
	}
}

let latest: Record<string, unknown> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

// Best effort: pushes the config to Nakama, retrying with backoff while it is
// unreachable (it may boot after the API). A newer push replaces a pending
// retry, so only the latest config is ever sent.
export function pushConfigToNakama(config: AppConfig): Promise<boolean> {
	if (!isNakamaAdminEnabled()) return Promise.resolve(false)
	latest = nakamaConfigOf(config)
	if (retryTimer) clearTimeout(retryTimer)
	retryTimer = null
	return attempt(latest, 0)
}

async function attempt(body: Record<string, unknown>, tries: number): Promise<boolean> {
	const result = await callNakamaRpc('admin_config_set', body)
	if (result.ok) return true
	if (body !== latest || tries >= RETRY_DELAYS_MS.length) {
		if (body === latest) console.warn(`[nakama] Gave up pushing config: ${result.error}`)
		return false
	}
	retryTimer = setTimeout(() => {
		retryTimer = null
		void attempt(body, tries + 1)
	}, RETRY_DELAYS_MS[tries])
	retryTimer.unref?.()
	return false
}
