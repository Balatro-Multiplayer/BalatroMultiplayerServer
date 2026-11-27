import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import express, { Router } from 'express'
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
import { inspectModArchive } from './mod-version-hash.js'
import { looksLikeZip } from './pin-proxy.js'
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
	inspect: inspectModArchive,
	storePin: storeRankedPin,
	startSwitch: upsertPinProxySwitch,
	reloadConfig: async () => {
		await loadConfigFromDb()
	},
	publicBaseUrl: env.WEB_BASE_URL,
	skipFirstWait: env.MOD_PIN_PROXY_SKIP_FIRST_WAIT,
	now: () => new Date(),
})

const ERRORS: Record<PinProxyError, [number, string]> = {
	'mod-not-found': [404, 'Mod not found'],
	'mod-not-allowed': [403, 'That mod cannot be pinned through the proxy'],
	'bad-version': [400, 'version must look like 1.2.3'],
	'hash-failed': [502, "Couldn't hash the posted zip"],
	'pin-failed': [400, "Couldn't pin that version"],
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

// The most a posted zip may be. The real package is about 8 MB.
export const PIN_PROXY_MAX_ZIP_BYTES = 50 * 1024 * 1024

// POST /api/ci/ranked-pin-proxy?mod=&version=[&forceProxy=true], with the zip
// as the raw body (Content-Type: application/zip): pins the mod to that zip
// served through this Server's proxy and starts the timer that later moves
// the pin to Thunderstore. The Server fetches nothing: the workflow sends the
// exact zip it uploaded to Thunderstore.
export function createCiRouter() {
	const router = Router()
	router.use(requireModPinProxyToken)

	router.post(
		'/ranked-pin-proxy',
		express.raw({
			type: 'application/zip',
			limit: PIN_PROXY_MAX_ZIP_BYTES,
		}),
		async (req, res) => {
			const mod = text(req.query.mod)
			const version = text(req.query.version)
			const forceProxy = req.query.forceProxy === 'true'
			if (!mod) throw new AppError('mod is required', 400)
			if (!version) throw new AppError('version is required', 400)
			const zip = req.body
			if (!Buffer.isBuffer(zip) || zip.length === 0)
				throw new AppError(
					'The body must be the zip, sent with Content-Type: application/zip',
					400,
				)
			if (!looksLikeZip(zip)) throw new AppError('The body is not a zip', 400)

			const result = await pinThroughProxy(
				{ mod, version, zip, forceProxy },
				liveDeps(),
			)
			if (!result.ok) {
				const [status, message] = ERRORS[result.reason]
				throw new AppError(message, status)
			}
			await logDeployAction({
				action: 'mod_pin',
				reason: `Release ${version} pinned by the release workflow${result.mode === 'proxy' ? ' through the Server proxy' : ''}`,
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
		},
	)

	return router
}
