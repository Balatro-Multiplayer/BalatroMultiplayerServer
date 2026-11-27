import { type Result, err, ok } from '../../shared/utils/result.js'
import type { RepoInfo } from './github-api.js'
import { extractRepoInfo } from './github-api.js'

// The pin proxy: a ranked pin whose download is served by this Server from a
// GitHub release asset, while the same package waits for Thunderstore's
// approval (ranked-pin-proxy.service.ts, pin-proxy-switch.service.ts).

// Mods that may be pinned through the proxy. A mod id, as in mod_registry.
export const PIN_PROXY_MOD_IDS: readonly string[] = ['MultiplayerAPI']

// First check 10 minutes after the pin, then every 2 minutes, for at most 7
// days. Then the proxy pin stays and the switch is marked gave_up.
export const PIN_PROXY_FIRST_CHECK_MS = 10 * 60 * 1000
export const PIN_PROXY_RETRY_MS = 2 * 60 * 1000
export const PIN_PROXY_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000

// Thunderstore version numbers: major.minor.patch, nothing else.
const VERSION = /^\d+\.\d+\.\d+$/
export const isPinProxyVersion = (version: string) => VERSION.test(version)

// https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.zip, with a
// plain character set and no query or fragment, so a request can only name a
// file of a release.
const RELEASE_ZIP =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([\w.+-]+)\/([\w.+-]+\.zip)$/

export interface ProxyAsset {
	assetUrl: string
	tag: string
	assetName: string
}

export type ProxyAssetError = 'bad-asset-url' | 'wrong-repo'

// The asset must be a release zip of the mod's own repository (the repo_url
// of its mod_registry row), compared without regard to case.
export function parseProxyAsset(
	assetUrl: string,
	repoUrl: string | null,
): Result<ProxyAsset, ProxyAssetError> {
	const match = RELEASE_ZIP.exec(assetUrl)
	if (!match) return err('bad-asset-url')
	const repo: RepoInfo | null = extractRepoInfo(repoUrl)
	if (
		!repo ||
		repo.owner.toLowerCase() !== (match[1] as string).toLowerCase() ||
		repo.repo.toLowerCase() !== (match[2] as string).toLowerCase()
	)
		return err('wrong-repo')
	return ok({
		assetUrl,
		tag: match[3] as string,
		assetName: match[4] as string,
	})
}

// The pin's download URL: this Server's public address, then the proxy route
// (mods.route.ts). It ends with the file name, like a Thunderstore download.
export function proxyDownloadUrl(
	baseUrl: string,
	modId: string,
	version: string,
	assetName: string,
): string {
	const base = baseUrl.replace(/\/+$/, '')
	return `${base}/api/mods/${encodeURIComponent(modId)}/pin-proxy/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`
}
