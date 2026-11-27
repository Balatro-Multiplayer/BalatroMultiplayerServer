import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import {
	isPinProxyVersion,
	looksLikeZip,
	proxyAssetName,
	proxyDownloadUrl,
} from '../../features/mods/pin-proxy.js'

describe('proxyAssetName', () => {
	it('is the package full name, the version and .zip', () => {
		expect(
			proxyAssetName(
				'BalatroMultiplayer-MultiplayerAPI',
				'MultiplayerAPI',
				'1.2.3',
			),
		).toBe('BalatroMultiplayer-MultiplayerAPI-1.2.3.zip')
	})

	it('falls back to the mod id', () => {
		expect(proxyAssetName(null, 'MultiplayerAPI', '1.2.3')).toBe(
			'MultiplayerAPI-1.2.3.zip',
		)
	})
})

describe('looksLikeZip', () => {
	it('accepts a zip and refuses anything else', () => {
		expect(looksLikeZip(new AdmZip().toBuffer())).toBe(true)
		expect(looksLikeZip(Buffer.from('PK\x03\x04rest'))).toBe(true)
		expect(looksLikeZip(Buffer.alloc(0))).toBe(false)
		expect(looksLikeZip(Buffer.from('PK'))).toBe(false)
		expect(looksLikeZip(Buffer.from('<html>not a zip</html>'))).toBe(false)
	})
})

describe('proxyDownloadUrl', () => {
	it('builds the URL on the public base and ends with the file name', () => {
		expect(
			proxyDownloadUrl(
				'https://balatromp.com/',
				'MultiplayerAPI',
				'1.2.3',
				'MultiplayerAPI-1.2.3.zip',
			),
		).toBe(
			'https://balatromp.com/api/mods/MultiplayerAPI/pin-proxy/1.2.3/MultiplayerAPI-1.2.3.zip',
		)
	})
})

describe('isPinProxyVersion', () => {
	it('takes major.minor.patch only', () => {
		expect(isPinProxyVersion('0.12.3')).toBe(true)
		for (const bad of ['v1.2.3', '1.2', '1.2.3-beta', '../1.2.3', '1.2.3 '])
			expect(isPinProxyVersion(bad)).toBe(false)
	})
})
