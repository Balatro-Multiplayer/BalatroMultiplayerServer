import { createHash } from 'node:crypto'
import type { SetRankedVersionResult } from '../../infrastructure/gateways/mods.gateway.js'
import type { ReleaseInspection } from './mod-version-hash.js'
import type { ModLayout } from './mod-version-hash.js'
import {
	PIN_PROXY_FIRST_CHECK_MS,
	PIN_PROXY_MOD_IDS,
	isPinProxyVersion,
	proxyAssetName,
	proxyDownloadUrl,
} from './pin-proxy.js'

// Pins a mod to a release that is served by this Server from the zip the release
// workflow posted, because its Thunderstore version waits for approval. The
// zip is the exact one that went to Thunderstore, so the hash recorded here is the one
// the Thunderstore version has, and the later switch changes only the URL.

export interface PinProxyModRow {
	id: string
	thunderstoreFullName: string | null
	rankedVersion: string | null
}

export interface PinProxyDeps {
	findMod(idOrFullName: string): Promise<PinProxyModRow | null>
	hasThunderstoreVersion(modId: string, version: string): Promise<boolean>
	// Pins a version that Thunderstore already lists, by the normal admin path.
	setRankedVersion(
		modId: string,
		version: string,
	): Promise<SetRankedVersionResult>
	inspect(
		modId: string,
		version: string,
		zip: Buffer,
		layout: ModLayout,
	): Promise<ReleaseInspection | null>
	storePin(
		modId: string,
		pin: {
			version: string
			downloadUrl: string
			source: ModLayout
			hash: string
			smodsIds: string[]
			fileHashes: Record<string, string>
		},
	): Promise<void>
	startSwitch(input: {
		modId: string
		version: string
		assetName: string
		proxyUrl: string
		proxyHash: string
		zipBytes: Buffer
		zipSha256: string
		startedAt: Date
		nextCheckAt: Date
	}): Promise<void>
	reloadConfig(): Promise<void>
	publicBaseUrl: string
	// Check Thunderstore at once instead of after the first wait.
	skipFirstWait: boolean
	now(): Date
}

export type PinProxyError =
	| 'mod-not-found'
	| 'mod-not-allowed'
	| 'bad-version'
	| 'hash-failed'
	| 'pin-failed'

export type PinProxyResult =
	| {
			ok: true
			// 'proxy': pinned to this Server's URL, the switch timer started.
			// 'thunderstore': the version is already listed, pinned the normal way.
			mode: 'proxy' | 'thunderstore'
			modId: string
			previousVersion: string | null
			proxyUrl: string | null
			nextCheckAt: Date | null
	  }
	| { ok: false; reason: PinProxyError }

export async function pinThroughProxy(
	input: {
		mod: string
		version: string
		// The raw zip, already checked to look like one.
		zip: Buffer
		// Serve through the proxy even when Thunderstore already lists the
		// version: a hand-run check of the proxy and the switch timer.
		forceProxy?: boolean
	},
	deps: PinProxyDeps,
): Promise<PinProxyResult> {
	const mod = await deps.findMod(input.mod)
	if (!mod) return { ok: false, reason: 'mod-not-found' }
	// The same answer for an unknown mod and a mod that is not allowed would
	// hide which ids exist, but the catalog is public, so be plain.
	if (!PIN_PROXY_MOD_IDS.includes(mod.id))
		return { ok: false, reason: 'mod-not-allowed' }
	if (!isPinProxyVersion(input.version))
		return { ok: false, reason: 'bad-version' }

	const previousVersion = mod.rankedVersion
	if (
		!input.forceProxy &&
		(await deps.hasThunderstoreVersion(mod.id, input.version))
	) {
		const pinned = await deps.setRankedVersion(mod.id, input.version)
		if (!pinned.ok)
			return {
				ok: false,
				reason: pinned.reason === 'hash-failed' ? 'hash-failed' : 'pin-failed',
			}
		await deps.reloadConfig()
		return {
			ok: true,
			mode: 'thunderstore',
			modId: mod.id,
			previousVersion,
			proxyUrl: null,
			nextCheckAt: null,
		}
	}

	// Hashed from the posted zip itself, with the layout of a Thunderstore package:
	// the same steps and bytes as the Thunderstore version will be.
	const inspected = await deps.inspect(
		mod.id,
		input.version,
		input.zip,
		'thunderstore',
	)
	if (!inspected) return { ok: false, reason: 'hash-failed' }

	const assetName = proxyAssetName(
		mod.thunderstoreFullName,
		mod.id,
		input.version,
	)
	const proxyUrl = proxyDownloadUrl(
		deps.publicBaseUrl,
		mod.id,
		input.version,
		assetName,
	)
	const startedAt = deps.now()
	const nextCheckAt = new Date(
		startedAt.getTime() + (deps.skipFirstWait ? 0 : PIN_PROXY_FIRST_CHECK_MS),
	)
	// The switch row goes first: the proxy route serves from it, and a pin with
	// no row would never move to Thunderstore.
	await deps.startSwitch({
		modId: mod.id,
		version: input.version,
		assetName,
		proxyUrl,
		proxyHash: inspected.hash,
		zipBytes: input.zip,
		zipSha256: createHash('sha256').update(input.zip).digest('hex'),
		startedAt,
		nextCheckAt,
	})
	await deps.storePin(mod.id, {
		version: input.version,
		downloadUrl: proxyUrl,
		source: 'thunderstore',
		...inspected,
	})
	await deps.reloadConfig()
	return {
		ok: true,
		mode: 'proxy',
		modId: mod.id,
		previousVersion,
		proxyUrl,
		nextCheckAt,
	}
}
