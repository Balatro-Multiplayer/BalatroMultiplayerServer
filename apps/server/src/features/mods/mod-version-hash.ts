import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { relocateModRoot } from './mod-archive-flatten.js'
import { computeModFolderHash } from './mod-folder-hash.js'
import { readSmodsIds } from './mod-smods-ids.js'

const HASH_FETCH_TIMEOUT_MS = 30_000

// How an extracted archive becomes a deployed mod folder. 'thunderstore'
// packages deploy exactly as shipped -- they're built for r2modman, which
// copies them verbatim, and flattening breaks lovely-module packages whose
// root patches load a subfolder. Every other source ('github': GitHub
// zipballs, release assets, admin raw URLs) goes through the canonical
// flatten. The launcher applies the same rule per version source.
export type ModLayout = 'thunderstore' | 'github'

export async function applyLayout(
	extractedDir: string,
	layout: ModLayout,
): Promise<void> {
	if (layout === 'github') await relocateModRoot(extractedDir)
}

// tmpRoot's own random suffix already guarantees uniqueness between
// concurrent callers -- extractedDir just needs *a* name, since the folder's
// own name never enters the hash (computeModFolderHash() hashes paths
// relative to it). Kept version-derived purely for readability.
function extractedFolderName(version: string): string {
	const sanitized = version.replace(/[@/\\]/g, '_')
	return `${sanitized || '_default'}_extracted`
}

// The file names the launcher deploys beside the game executable (Lovely's
// DLL proxy, before and after v0.10.0, and its macOS dylib). Kept in step with
// the launcher's ModInstaller injectorFileNames().
const INJECTOR_FILE_NAMES = ['winmm.dll', 'version.dll', 'liblovely.dylib']

// SHA-256 of each injector file found anywhere in dir (the first match by
// shallowest path wins; entries are read in name order so a tie is stable),
// keyed by lower-case file name.
export async function hashInjectorFiles(
	dir: string,
): Promise<Record<string, string>> {
	const found: Record<string, { depth: number; full: string }> = {}
	async function walk(current: string, depth: number): Promise<void> {
		const entries = await fs.readdir(current, { withFileTypes: true })
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) {
				await walk(full, depth + 1)
			} else if (entry.isFile()) {
				const name = entry.name.toLowerCase()
				if (
					INJECTOR_FILE_NAMES.includes(name) &&
					(!found[name] || depth < found[name].depth)
				) {
					found[name] = { depth, full }
				}
			}
		}
	}
	await walk(dir, 0)
	const out: Record<string, string> = {}
	for (const [name, { full }] of Object.entries(found)) {
		out[name] = createHash('sha256')
			.update(await fs.readFile(full))
			.digest('hex')
	}
	return out
}

// What a pin records about the folder it deploys as.
export interface ReleaseInspection {
	hash: string
	// SHA-256 of each injector file the extracted pin contains, by file name
	// ({} when none). See modRegistry.rankedFileHashes.
	fileHashes: Record<string, string>
	// The SMODS ids its files declare (mod-smods-ids.ts); [] when none.
	smodsIds: string[]
}

// Reproduces exactly what the launcher deploys into a player's Mods folder:
// downloads the archive, extracts it, lays it out per `layout`, then hashes
// the resulting folder (computeModFolderHash(), a port of the launcher's
// ModFileHash::hashDirectory()) and reads the SMODS ids it declares. Called
// when an admin pins a version and by the sync for a pin that has no hash
// yet -- only ranked pins are inspected.
// Best-effort: a dead URL or unreadable archive logs and returns null.
export async function inspectModRelease(
	modId: string,
	version: string,
	downloadUrl: string,
	layout: ModLayout,
): Promise<ReleaseInspection | null> {
	let tmpRoot: string | null = null
	try {
		const res = await fetch(downloadUrl, {
			signal: AbortSignal.timeout(HASH_FETCH_TIMEOUT_MS),
		})
		if (!res.ok) {
			console.error(
				`[mod-version-hash] Hash fetch failed (${res.status}) for ${downloadUrl}`,
			)
			return null
		}
		const rawBytes = Buffer.from(await res.arrayBuffer())

		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bmp-mod-hash-'))
		const extractedDir = path.join(tmpRoot, extractedFolderName(version))
		await fs.mkdir(extractedDir, { recursive: true })

		new AdmZip(rawBytes).extractAllTo(extractedDir, true)
		await applyLayout(extractedDir, layout)

		return {
			hash: await computeModFolderHash(extractedDir),
			fileHashes: await hashInjectorFiles(extractedDir),
			smodsIds: await readSmodsIds(extractedDir),
		}
	} catch (err) {
		console.error(`[mod-version-hash] Failed to hash ${modId}@${version}:`, err)
		return null
	} finally {
		if (tmpRoot) {
			await fs.rm(tmpRoot, { recursive: true, force: true })
		}
	}
}
