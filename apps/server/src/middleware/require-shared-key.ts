import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

// Guards a router with a shared key sent as X-BMP-Internal-Key. With no key
// configured every request is refused. `getKey` is read per request.
export function requireSharedKey(getKey: () => string) {
	return (req: Request, res: Response, next: NextFunction) => {
		const key = getKey()
		const sent = req.headers['x-bmp-internal-key']
		if (!key || typeof sent !== 'string') {
			res.status(401).json({ error: 'Missing internal key' })
			return
		}
		const expected = Buffer.from(key)
		const actual = Buffer.from(sent)
		if (
			expected.length !== actual.length ||
			!timingSafeEqual(expected, actual)
		) {
			res.status(403).json({ error: 'Bad internal key' })
			return
		}
		next()
	}
}
