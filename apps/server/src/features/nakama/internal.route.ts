import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { env } from '../../env.js'

// Routes only Nakama calls (nakama/src/express.ts), guarded by the shared
// INTERNAL_API_KEY. With no key configured every request is refused.
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
	const sent = req.headers['x-bmp-internal-key']
	if (!env.INTERNAL_API_KEY || typeof sent !== 'string') {
		res.status(401).json({ error: 'Missing internal key' })
		return
	}
	const expected = Buffer.from(env.INTERNAL_API_KEY)
	const actual = Buffer.from(sent)
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		res.status(403).json({ error: 'Bad internal key' })
		return
	}
	next()
}

export function createInternalNakamaRouter() {
	const router = Router()
	router.use(requireInternalKey)

	router.post('/ping', (_req, res) => {
		res.json({ ok: true })
	})

	return router
}
