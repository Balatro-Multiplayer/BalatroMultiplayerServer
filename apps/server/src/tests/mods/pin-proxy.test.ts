import { describe, expect, it } from 'vitest'
import {
	isPinProxyVersion,
	parseProxyAsset,
	proxyDownloadUrl,
} from '../../features/mods/pin-proxy.js'

const REPO = 'https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI'
const ASSET = `${REPO}/releases/download/v1.2.3/MultiplayerAPI-1.2.3.zip`

describe('parseProxyAsset', () => {
	it('takes a release zip of the mod own repo', () => {
		expect(parseProxyAsset(ASSET, REPO)).toEqual({
			ok: true,
			value: {
				assetUrl: ASSET,
				tag: 'v1.2.3',
				assetName: 'MultiplayerAPI-1.2.3.zip',
			},
		})
	})

	it('ignores case and a .git suffix when it compares the repo', () => {
		const lower = ASSET.replace('Balatro-Multiplayer', 'balatro-multiplayer')
		expect(parseProxyAsset(lower, `${REPO}.git`).ok).toBe(true)
	})

	it('refuses a release of another repo', () => {
		const other = ASSET.replace('BalatroMultiplayerAPI', 'SomethingElse')
		expect(parseProxyAsset(other, REPO)).toEqual({
			ok: false,
			error: 'wrong-repo',
		})
		expect(parseProxyAsset(ASSET, null)).toEqual({
			ok: false,
			error: 'wrong-repo',
		})
	})

	it.each([
		['http scheme', ASSET.replace('https', 'http')],
		['another host', 'https://evil.example/a/b/releases/download/v1/x.zip'],
		[
			'a host with the right name as user info',
			`https://github.com@evil.example/o/r/releases/download/v1/x.zip`,
		],
		['a query', `${ASSET}?token=1`],
		['a fragment', `${ASSET}#x`],
		['a path walk', `${REPO}/releases/download/v1/../../x.zip`],
		['not a zip', `${REPO}/releases/download/v1.2.3/readme.txt`],
		['a latest pointer', `${REPO}/releases/latest/download/x.zip`],
		['an encoded slash', `${REPO}/releases/download/v1/a%2Fb.zip`],
		['a source archive', `${REPO}/archive/refs/tags/v1.2.3.zip`],
	])('refuses %s', (_name, url) => {
		expect(parseProxyAsset(url, REPO)).toEqual({
			ok: false,
			error: 'bad-asset-url',
		})
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
