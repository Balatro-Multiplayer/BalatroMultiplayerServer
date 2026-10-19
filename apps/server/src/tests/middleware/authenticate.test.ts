import { describe, expect, it, vi } from 'vitest'
import { authenticate } from '../../middleware/authenticate.js'
import jwt from 'jsonwebtoken'
import { env } from '../../env.js'
import { signJwt, signTosPendingToken } from '../../features/auth/jwt.js'
import { generateLinkState } from '../../features/auth/link-state.js'
import type { Request, Response, NextFunction } from 'express'

function mockReqRes(authHeader?: string) {
	const req = {
		headers: { authorization: authHeader },
	} as unknown as Request

	const res = {
		status: vi.fn().mockReturnThis(),
		json: vi.fn().mockReturnThis(),
	} as unknown as Response

	const next = vi.fn() as NextFunction

	return { req, res, next }
}

describe('authenticate middleware', () => {
	it('returns 401 when no Authorization header', () => {
		const { req, res, next } = mockReqRes()
		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(res.json).toHaveBeenCalledWith({
			error: 'Missing or malformed Authorization header',
		})
		expect(next).not.toHaveBeenCalled()
	})

	it('returns 401 for non-Bearer token', () => {
		const { req, res, next } = mockReqRes('Basic abc123')
		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(next).not.toHaveBeenCalled()
	})

	it('returns 401 for invalid JWT', () => {
		const { req, res, next } = mockReqRes('Bearer garbage-token')
		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(res.json).toHaveBeenCalledWith({
			error: 'Invalid or expired token',
		})
		expect(next).not.toHaveBeenCalled()
	})

	it('populates req.player and calls next for valid JWT', () => {
		const token = signJwt({ playerId: 'steam1', steamName: 'Alice' })
		const { req, res, next } = mockReqRes(`Bearer ${token}`)

		authenticate(req, res, next)

		expect(req.player).toMatchObject({ playerId: 'steam1', steamName: 'Alice' })
		expect(next).toHaveBeenCalled()
		expect(res.status).not.toHaveBeenCalled()
	})

	it('refuses the ToS-pending token as a session (the ToS gate would be skipped)', () => {
		const { req, res, next } = mockReqRes(`Bearer ${signTosPendingToken('p-no-tos')}`)

		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(next).not.toHaveBeenCalled()
		expect(req.player).toBeUndefined()
	})

	it('refuses the Discord link-state token as a session', () => {
		const { req, res, next } = mockReqRes(`Bearer ${generateLinkState('p-link')}`)

		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(next).not.toHaveBeenCalled()
	})

	it('refuses a signed token without a playerId', () => {
		const token = jwt.sign({ steamName: 'NoId' }, env.JWT_SECRET)
		const { req, res, next } = mockReqRes(`Bearer ${token}`)

		authenticate(req, res, next)

		expect(res.status).toHaveBeenCalledWith(401)
		expect(next).not.toHaveBeenCalled()
	})
})
