import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../shared/utils/errors.js'

// Postgres "invalid_text_representation": a value it can't parse for the
// column's type -- in practice a request's malformed uuid (`/players/abc`) or
// number (`?page=abc`) reaching a query. That's the client's mistake, not ours.
const PG_INVALID_TEXT = '22P02'

function pgCode(err: unknown): unknown {
	const e = err as { code?: unknown; cause?: { code?: unknown } }
	return e?.code ?? e?.cause?.code
}

export function errorHandler(
	err: Error,
	_req: Request,
	res: Response,
	_next: NextFunction,
) {
	if (err instanceof AppError) {
		res.status(err.statusCode).json({ error: err.message })
		return
	}

	if (pgCode(err) === PG_INVALID_TEXT) {
		console.warn('[error] Invalid request value:', err.message)
		res.status(400).json({ error: 'Invalid request value' })
		return
	}

	console.error('[error] Unexpected error:', err)
	res.status(500).json({ error: 'Internal server error' })
}
