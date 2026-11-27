// The pin proxy: a ranked pin whose download is served by this Server from the
// zip the release workflow posted, while the same package waits for Thunderstore's
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

// The file name a proxy pin's zip is served under: the Thunderstore package
// full name (<namespace>-<name>), the version, then .zip, like a package
// built for Thunderstore. A mod with no Thunderstore name uses its id.
export function proxyAssetName(
	thunderstoreFullName: string | null,
	modId: string,
	version: string,
): string {
	return `${thunderstoreFullName || modId}-${version}.zip`
}

// A zip starts with the local file header signature, "PK\x03\x04"; an empty
// zip starts with the end of central directory one, "PK\x05\x06".
export function looksLikeZip(bytes: Buffer): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) ||
			(bytes[2] === 0x05 && bytes[3] === 0x06))
	)
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
