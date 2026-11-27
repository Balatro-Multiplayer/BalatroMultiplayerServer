import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import { env } from '../../env.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import {
	hasThunderstoreVersion,
	upsertPinProxySwitch,
} from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import {
	findModByIdOrFullName,
	setRankedVersion,
	storeRankedPin,
} from '../../infrastructure/gateways/mods.gateway.js'
import { AppError } from '../../shared/utils/errors.js'
import { logDeployAction } from '../deploy/deploy-auth.js'
import { inspectModRelease } from './mod-version-hash.js'
import {
	type PinProxyDeps,
	type PinProxyError,
	pinThroughProxy,
} from './ranked-pin-proxy.service.js'

// Guards /api/ci. With no MOD_PIN_PROXY_TOKEN the routes do not exist as far
// as a caller can tell (404). Otherwise the call must carry
// `Authorization: Bearer <token>`, compared in constant time. Same shape as
// requireDeployToken, with its own token: this one can pin one mod only.
export function requireModPinProxyToken(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	if (!env.MOD_PIN_PROXY_TOKEN) {
		res.status(404).json({ error: 'Not found' })
		return
	}
	const header = req.headers.authorization
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
		res.status(401).json({ error: 'Missing token' })
		return
	}
	const expected = Buffer.from(env.MOD_PIN_PROXY_TOKEN)
	const actual = Buffer.from(header.slice('Bearer '.length))
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		res.status(403).json({ error: 'Bad token' })
		return
	}
	next()
}

const liveDeps = (): PinProxyDeps => ({
	findMod: findModByIdOrFullName,
	hasThunderstoreVersion,
	setRankedVersion,
	inspect: inspectModRelease,
	storePin: storeRankedPin,
	startSwitch: upsertPinProxySwitch,
	reloadConfig: async () => {
		await loadConfigFromDb()
	},
	publicBaseUrl: env.WEB_BASE_URL,
	now: () => new Date(),
})

const ERRORS: Record<PinProxyError, [number, string]> = {
	'mod-not-found': [404, 'Mod not found'],
	'mod-not-allowed': [403, 'That mod cannot be pinned through the proxy'],
	'bad-version': [400, 'version must look like 1.2.3'],
	'bad-asset-url': [
		400,
		'assetUrl must be a https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.zip URL',
	],
	'wrong-repo': [400, "assetUrl is not a release of the mod's own repo"],
	'hash-failed': [502, "Couldn't download or hash the release asset"],
	'pin-failed': [400, "Couldn't pin that version"],
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

// POST /api/ci/ranked-pin-proxy {mod, version, assetUrl}: pins the mod to the
// release asset served through this Server's proxy and starts the timer that
// later moves the pin to Thunderstore. The request names a file of the mod's
// own repo's releases and nothing else; the Server never fetches any other URL.
export function createCiRouter() {
	const router = Router()
	router.use(requireModPinProxyToken)

	router.post('/ranked-pin-proxy', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const mod = text(body.mod)
		const version = text(body.version)
		const assetUrl = text(body.assetUrl)
		if (!mod) throw new AppError('mod is required', 400)
		if (!version) throw new AppError('version is required', 400)
		if (!assetUrl) throw new AppError('assetUrl is required', 400)

		const result = await pinThroughProxy({ mod, version, assetUrl }, liveDeps())
		if (!result.ok) {
			const [status, message] = ERRORS[result.reason]
			throw new AppError(message, status)
		}
		await logDeployAction({
			action: 'mod_pin',
			reason: `Release ${version} pinned by the release workflow${result.mode === 'proxy' ? ' through the GitHub proxy' : ''}`,
			detail: {
				modId: result.modId,
				old: { rankedVersion: result.previousVersion },
				new: { rankedVersion: version, source: result.mode },
			},
		})
		res.json({
			ok: true,
			mode: result.mode,
			downloadUrl: result.proxyUrl,
			nextCheckAt: result.nextCheckAt,
		})
	})

	return router
}
