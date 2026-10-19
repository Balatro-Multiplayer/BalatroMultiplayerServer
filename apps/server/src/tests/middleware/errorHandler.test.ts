import { describe, expect, it, vi } from 'vitest'
import { errorHandler } from '../../middleware/errorHandler.js'
import { AppError } from '../../shared/utils/errors.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'

function mockRes() {
	return {
		status: vi.fn().mockReturnThis(),
		json: vi.fn().mockReturnThis(),
	} as unknown as Response
}

describe('errorHandler middleware', () => {
	const req = {} as Request
	const next = vi.fn() as NextFunction

	it('handles AppError with correct status and message', () => {
		const res = mockRes()
		const err = new AppError('Not found', 404)

		errorHandler(err, req, res, next)

		expect(res.status).toHaveBeenCalledWith(404)
		expect(res.json).toHaveBeenCalledWith({ error: 'Not found' })
	})

	it('handles unknown errors with 500', () => {
		const res = mockRes()
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		errorHandler(new Error('unexpected'), req, res, next)

		expect(res.status).toHaveBeenCalledWith(500)
		expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
		consoleSpy.mockRestore()
	})

	it('answers 400 for a request value Postgres cannot parse (a malformed uuid or number in the path or query)', () => {
		const res = mockRes()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const err = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: '22P02' })

		errorHandler(err, req, res, next)

		expect(res.status).toHaveBeenCalledWith(400)
		expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request value' })
		warn.mockRestore()
	})

	it('answers 400 for a request number out of its column range (?season=1e10)', () => {
		const res = mockRes()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const err = Object.assign(new Error('value "10000000000" is out of range for type integer'), { code: '22003' })

		errorHandler(err, req, res, next)

		expect(res.status).toHaveBeenCalledWith(400)
		warn.mockRestore()
	})
})

// The real express.json() errors, through a real app.
describe('errorHandler with express.json() body errors', () => {
	function app() {
		const a = express()
		a.use(express.json())
		a.post('/x', (_req, res) => {
			res.json({ ok: true })
		})
		a.use(errorHandler)
		return a
	}

	it('answers 400, not 500, for a malformed JSON body', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const res = await request(app()).post('/x').set('content-type', 'application/json').send('{bad')
		expect(res.status).toBe(400)
		expect(res.body).toEqual({ error: 'Malformed JSON body' })
		expect(error).not.toHaveBeenCalled()
		error.mockRestore()
	})

	it('answers 413 for a body over the limit', async () => {
		const res = await request(app())
			.post('/x')
			.set('content-type', 'application/json')
			.send(JSON.stringify({ a: 'x'.repeat(200_000) }))
		expect(res.status).toBe(413)
		expect(res.body).toEqual({ error: 'Request body too large' })
	})

	it('answers 415 for an unsupported content encoding or charset', async () => {
		const enc = await request(app())
			.post('/x')
			.set('content-type', 'application/json')
			.set('content-encoding', 'bogus')
			.send('{}')
		expect(enc.status).toBe(415)
		const cs = await request(app()).post('/x').set('content-type', 'application/json; charset=bogus').send('{}')
		expect(cs.status).toBe(415)
	})

	it('still parses a good body', async () => {
		const res = await request(app()).post('/x').set('content-type', 'application/json').send('{"a":1}')
		expect(res.status).toBe(200)
	})
})
