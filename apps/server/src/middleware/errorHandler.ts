import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../shared/utils/errors.js'

// Postgres "invalid_text_representation": a value it can't parse for the
// column's type -- in practice a request's malformed uuid (`/players/abc`) or
// number (`?page=abc`) reaching a query. That's the client's mistake, not ours.
const PG_INVALID_TEXT = '22P02'
// Postgres "numeric_value_out_of_range": a request number too big for its
// column (`?season=1e10` for an integer).
const PG_OUT_OF_RANGE = '22003'

function pgCode(err: unknown): unknown {
	const e = err as { code?: unknown; cause?: { code?: unknown } }
	return e?.code ?? e?.cause?.code
}

// express.json() (body-parser) fails with an http-errors error: a `type`
// such as 'entity.parse.failed' or 'entity.too.large' and a 4xx `status`.
// Those are the client's malformed body, not a server fault.
function bodyParserStatus(err: unknown): number | null {
	const e = err as { type?: unknown; status?: unknown }
	if (typeof e?.type !== 'string' || typeof e.status !== 'number') return null
	return e.status >= 400 && e.status < 500 ? e.status : null
}

const BODY_ERRORS: Record<string, string> = {
	'entity.parse.failed': 'Malformed JSON body',
	'entity.too.large': 'Request body too large',
	'encoding.unsupported': 'Unsupported content encoding',
	'charset.unsupported': 'Unsupported charset',
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

	const bodyStatus = bodyParserStatus(err)
	if (bodyStatus !== null) {
		const type = (err as unknown as { type: string }).type
		res.status(bodyStatus).json({ error: BODY_ERRORS[type] ?? 'Bad request body' })
		return
	}

	const code = pgCode(err)
	if (code === PG_INVALID_TEXT || code === PG_OUT_OF_RANGE) {
		console.warn('[error] Invalid request value:', err.message)
		res.status(400).json({ error: 'Invalid request value' })
		return
	}

	console.error('[error] Unexpected error:', err)
	res.status(500).json({ error: 'Internal server error' })
}
