import { checkDownloadAvailable } from './ranked-pin-health.js'

// The Balatro community's package list: the list r2modman and the mods sync
// read. A package in review is missing from it, but the experimental package
// API and the download link answer during review, so those alone cannot tell.
const COMMUNITY_INDEX_URL = 'https://thunderstore.io/c/balatro/api/v1/package/'
const FETCH_TIMEOUT_MS = 30_000

interface IndexPackage {
	full_name?: string
	is_active?: boolean
	versions?: {
		version_number?: string
		is_active?: boolean
		download_url?: string
	}[]
}

// Whether one exact version of a Thunderstore package is up: the community
// package list shows it and its download works. Any doubt (a network error, a
// rate limit, an odd answer) is 'not-up': the caller asks again.
export async function checkThunderstoreVersion(
	fullName: string,
	version: string,
): Promise<'up' | 'not-up'> {
	try {
		const res = await fetch(COMMUNITY_INDEX_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
		if (!res.ok) return 'not-up'
		const index = (await res.json()) as IndexPackage[]
		if (!Array.isArray(index)) return 'not-up'
		const pkg = index.find((p) => p.full_name === fullName)
		if (!pkg || pkg.is_active === false) return 'not-up'
		const entry = pkg.versions?.find((v) => v.version_number === version)
		if (!entry || entry.is_active === false || !entry.download_url)
			return 'not-up'
		return (await checkDownloadAvailable(entry.download_url)) === 'ok'
			? 'up'
			: 'not-up'
	} catch {
		return 'not-up'
	}
}
