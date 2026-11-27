import { Readable } from 'node:stream'
import type { Request, Response } from 'express'
import { findPinProxySwitch } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import { findModByIdOrFullName } from '../../infrastructure/gateways/mods.gateway.js'

const UPSTREAM_TIMEOUT_MS = 30_000

// GET (and HEAD) /api/mods/:id/pin-proxy/:version/:file: the GitHub release
// asset of a proxy pin, streamed. The asset URL comes from the switch row the
// release workflow's pin wrote, never from the request: the request only picks
// a row, and :file must be that row's file name. The bytes are the package
// that went to Thunderstore, so a player's hash check passes as it will on
// Thunderstore.
export async function servePinProxyAsset(req: Request, res: Response) {
	const mod = await findModByIdOrFullName(String(req.params.id))
	const row = mod
		? await findPinProxySwitch(mod.id, String(req.params.version))
		: null
	if (!row || row.assetName !== String(req.params.file)) {
		res.status(404).json({ error: 'Not found' })
		return
	}

	const head = req.method === 'HEAD'
	let upstream: Response | globalThis.Response
	try {
		upstream = await fetch(row.assetUrl, {
			method: head ? 'HEAD' : 'GET',
			redirect: 'follow',
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		})
	} catch (err) {
		console.warn(`[pin-proxy] Fetch failed for ${row.assetUrl}:`, err)
		res.status(502).json({ error: 'The download source is not reachable' })
		return
	}
	if (!upstream.ok) {
		await upstream.body?.cancel()
		// A gone asset is a 404, so the sync's health check flags the pin; any
		// other failure is the source's trouble and may pass.
		res
			.status(upstream.status === 404 ? 404 : 502)
			.json({ error: 'The download source did not serve the file' })
		return
	}

	res.status(200)
	res.setHeader('Content-Type', 'application/zip')
	res.setHeader(
		'Content-Disposition',
		`attachment; filename="${row.assetName.replace(/[^\w.+-]/g, '_')}"`,
	)
	res.setHeader('Cache-Control', 'public, max-age=3600')
	res.setHeader('X-Content-Type-Options', 'nosniff')
	const length = upstream.headers.get('content-length')
	if (length && !upstream.headers.get('content-encoding'))
		res.setHeader('Content-Length', length)
	if (head || !upstream.body) {
		await upstream.body?.cancel()
		res.end()
		return
	}
	const stream = Readable.fromWeb(upstream.body as never)
	stream.on('error', () => res.destroy())
	res.on('close', () => stream.destroy())
	stream.pipe(res)
}
