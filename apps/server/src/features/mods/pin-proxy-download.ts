import type { Request, Response } from 'express'
import { findPinProxyZip } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import { findModByIdOrFullName } from '../../infrastructure/gateways/mods.gateway.js'

// GET (and HEAD) /api/mods/:id/pin-proxy/:version/:file: the zip of a proxy
// pin, from the bytes the release workflow posted. The request only picks a
// switch row, and :file must be that row's file name. The bytes are the package
// that went to Thunderstore, so a player's hash check passes as it will on
// Thunderstore. A row whose bytes were cleared (the pin moved on) is a 404.
export async function servePinProxyAsset(req: Request, res: Response) {
	const mod = await findModByIdOrFullName(String(req.params.id))
	const row = mod
		? await findPinProxyZip(mod.id, String(req.params.version))
		: null
	if (!row || row.assetName !== String(req.params.file)) {
		res.status(404).json({ error: 'Not found' })
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
	res.setHeader('ETag', `"${row.zipSha256}"`)
	res.setHeader('Content-Length', String(row.zipBytes.length))
	if (req.fresh) {
		res.status(304).end()
		return
	}
	if (req.method === 'HEAD') {
		res.end()
		return
	}
	res.end(row.zipBytes)
}
