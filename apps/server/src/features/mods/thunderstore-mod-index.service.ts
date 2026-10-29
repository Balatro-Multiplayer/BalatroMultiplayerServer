// Thunderstore's own Balatro community package list -- a single unauthenticated
// GET returns the whole catalog (~140 packages as of writing, confirmed live),
// no pagination, no token. This is the sole mod index source (see
// drizzle/0041_mod_registry_thunderstore_only.sql).
const PACKAGE_INDEX_URL = 'https://thunderstore.io/c/balatro/api/v1/package/'
const FETCH_TIMEOUT_MS = 60_000

// The community list is a cached copy and can lag a new release by hours (a
// brand new package was missing for most of a day). Our own packages are also
// read straight from the per-package endpoint, so a release shows up at once.
const PACKAGE_URL = 'https://thunderstore.io/api/experimental/package'
const COMMUNITY = 'balatro'
const DIRECT_PACKAGES = [
	{ owner: 'BalatroMultiplayer', name: 'MultiplayerAPI' },
	{ owner: 'BalatroMultiplayer', name: 'MultiplayerPvP' },
	{ owner: 'BalatroMultiplayer', name: 'MultiplayerSpeedrun' },
]

// Dependency strings are "Owner-Name-Version". Steamodded is published under
// more than one owner (Steamodded-Steamodded, Steamopollys-Steamodded), so
// match on the package name alone.
const STEAMODDED_DEPENDENCY = /^[^-]+-Steamodded-/
// Talisman has no Thunderstore package today; kept so a future one counts.
const TALISMAN_DEPENDENCY = /^[^-]+-Talisman-/

export interface ModIndexVersionInput {
	version: string
	downloadUrl: string
	releasedAt: string | null
	dependencies: string[]
}

export interface ModIndexEntryInput {
	fullName: string
	title: string
	author: string
	categories: string[]
	requiresSteamodded: boolean
	requiresTalisman: boolean
	repoUrl: string | null
	thumbnailUrl: string | null
	description: string | null
	packageUrl: string | null
	donationLink: string | null
	latestVersion: string
	latestDownloadUrl: string
	sourceUpdatedAt: string | null
	// Active versions only, newest first.
	versions: ModIndexVersionInput[]
}

export interface ThunderstoreIndexResult {
	entries: ModIndexEntryInput[]
	// Deprecated packages, or packages with no is_active version at all.
	skipped: number
}

interface ThunderstoreVersion {
	description: string
	icon: string
	version_number: string
	dependencies: string[]
	download_url: string
	date_created: string
	website_url: string
	is_active: boolean
}

export interface ThunderstorePackage {
	name: string
	full_name: string
	owner: string
	categories: string[]
	package_url: string
	// Only present on packages that set one.
	donation_link?: string
	date_updated: string
	is_deprecated: boolean
	versions: ThunderstoreVersion[]
}

async function fetchPackageList(): Promise<ThunderstorePackage[]> {
	const res = await fetch(PACKAGE_INDEX_URL, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`thunderstore package index fetch failed: ${res.status}`)
	}
	return (await res.json()) as ThunderstorePackage[]
}

interface ThunderstoreDirectPackage {
	name: string
	full_name: string
	owner: string
	package_url: string
	date_updated: string
	is_deprecated: boolean
	donation_link?: string
	community_listings?: { community_identifier: string; categories: string[] }[]
	latest?: ThunderstoreVersion
}

// The per-package endpoint returns the latest version only. Maps it to the
// list's shape, or null for a response that is not a package.
export function fromDirectPackage(
	raw: ThunderstoreDirectPackage,
): ThunderstorePackage | null {
	if (!raw?.full_name || !raw.latest?.version_number) return null
	const listing = raw.community_listings?.find(
		(l) => l.community_identifier === COMMUNITY,
	)
	return {
		name: raw.name,
		full_name: raw.full_name,
		owner: raw.owner,
		categories: listing?.categories ?? [],
		package_url: raw.package_url,
		donation_link: raw.donation_link,
		date_updated: raw.date_updated,
		is_deprecated: raw.is_deprecated,
		versions: [raw.latest],
	}
}

async function fetchDirectPackage(
	owner: string,
	name: string,
): Promise<ThunderstorePackage | null> {
	try {
		const res = await fetch(`${PACKAGE_URL}/${owner}/${name}/`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
		if (!res.ok) throw new Error(`status ${res.status}`)
		const pkg = fromDirectPackage(
			(await res.json()) as ThunderstoreDirectPackage,
		)
		if (!pkg) throw new Error('not a package')
		return pkg
	} catch (err) {
		console.warn(`[mods-sync] direct fetch failed for ${owner}/${name}:`, err)
		return null
	}
}

function versionKey(v: string): number[] {
	return v.split('.').map((n) => Number.parseInt(n, 10) || 0)
}

function isNewer(a: string, b: string): boolean {
	const x = versionKey(a)
	const y = versionKey(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d !== 0) return d > 0
	}
	return false
}

// Adds a directly fetched package to the list: a package the list lacks is
// appended, a package the list has keeps its full version history, with the
// direct version put first when it is newer.
export function mergeDirectPackage(
	list: ThunderstorePackage[],
	direct: ThunderstorePackage,
): ThunderstorePackage[] {
	const at = list.findIndex((p) => p.full_name === direct.full_name)
	if (at === -1) return [...list, direct]
	const listed = list[at] as ThunderstorePackage
	const latest = direct.versions[0] as ThunderstoreVersion
	const known = listed.versions.find((v) => v.is_active)
	if (known && !isNewer(latest.version_number, known.version_number))
		return list
	const merged: ThunderstorePackage = {
		...direct,
		categories: direct.categories.length
			? direct.categories
			: listed.categories,
		versions: [
			latest,
			...listed.versions.filter(
				(v) => v.version_number !== latest.version_number,
			),
		],
	}
	return list.map((p, i) => (i === at ? merged : p))
}

// Maps one package to the row mods-sync.service.ts upserts, or null for a
// package that shouldn't be listed (deprecated, or nothing active). Versions
// are newest first in Thunderstore's own response order (confirmed live), so
// the first active one is the latest.
export function toModIndexEntry(
	pkg: ThunderstorePackage,
): ModIndexEntryInput | null {
	if (pkg.is_deprecated) return null
	const active = pkg.versions.filter((v) => v.is_active)
	const latest = active[0]
	if (!latest) return null

	const dependsOn = (pattern: RegExp) =>
		active.some((v) => v.dependencies.some((d) => pattern.test(d)))

	return {
		fullName: pkg.full_name,
		title: pkg.name,
		author: pkg.owner,
		categories: pkg.categories,
		requiresSteamodded: dependsOn(STEAMODDED_DEPENDENCY),
		requiresTalisman: dependsOn(TALISMAN_DEPENDENCY),
		repoUrl: latest.website_url || null,
		thumbnailUrl: latest.icon || null,
		description: latest.description || null,
		packageUrl: pkg.package_url || null,
		donationLink: pkg.donation_link || null,
		latestVersion: latest.version_number,
		latestDownloadUrl: latest.download_url,
		sourceUpdatedAt: pkg.date_updated || null,
		versions: active.map((v) => ({
			version: v.version_number,
			downloadUrl: v.download_url,
			releasedAt: v.date_created || null,
			dependencies: v.dependencies,
		})),
	}
}

export async function fetchThunderstoreModIndex(): Promise<ThunderstoreIndexResult> {
	let packages = await fetchPackageList()
	const direct = await Promise.all(
		DIRECT_PACKAGES.map((p) => fetchDirectPackage(p.owner, p.name)),
	)
	for (const pkg of direct) {
		if (pkg) packages = mergeDirectPackage(packages, pkg)
	}

	const entries: ModIndexEntryInput[] = []
	let skipped = 0
	for (const pkg of packages) {
		const entry = toModIndexEntry(pkg)
		if (entry) entries.push(entry)
		else skipped++
	}

	return { entries, skipped }
}
