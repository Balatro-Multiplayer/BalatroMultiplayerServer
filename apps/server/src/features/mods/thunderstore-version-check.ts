import { checkDownloadAvailable } from './ranked-pin-health.js'

const PACKAGE_URL = 'https://thunderstore.io/api/experimental/package'
const FETCH_TIMEOUT_MS = 15_000

// Whether one exact version of a Thunderstore package is up: its page answers
// and its download works. A version that waits for approval has neither, so
// this is true only once players can really download it. Any doubt (a network
// error, a rate limit, an odd answer) is 'not-up': the caller asks again.
export async function checkThunderstoreVersion(
	fullName: string,
	version: string,
): Promise<'up' | 'not-up'> {
	const split = fullName.indexOf('-')
	if (split <= 0) return 'not-up'
	const owner = fullName.slice(0, split)
	const name = fullName.slice(split + 1)
	try {
		const res = await fetch(
			`${PACKAGE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/`,
			{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
		)
		if (!res.ok) return 'not-up'
		const body = (await res.json()) as {
			version_number?: string
			is_active?: boolean
			download_url?: string
		}
		if (body.version_number !== version || body.is_active === false)
			return 'not-up'
		const downloadUrl =
			body.download_url ??
			`https://thunderstore.io/package/download/${owner}/${name}/${version}/`
		return (await checkDownloadAvailable(downloadUrl)) === 'ok'
			? 'up'
			: 'not-up'
	} catch {
		return 'not-up'
	}
}
