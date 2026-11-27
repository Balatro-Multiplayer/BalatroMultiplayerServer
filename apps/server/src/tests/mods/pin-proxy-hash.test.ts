import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectModRelease } from '../../features/mods/mod-version-hash.js'

// The proxy serves the exact zip that goes to Thunderstore, and the pin is
// hashed with the Thunderstore layout from either URL, so the hash a player
// sees does not change at the switch.
function packageZip(): Buffer {
	const zip = new AdmZip()
	zip.addFile('manifest.json', Buffer.from('{"name":"MultiplayerAPI"}'))
	zip.addFile(
		'MultiplayerAPI/MultiplayerAPI.json',
		Buffer.from('{"id":"MultiplayerAPI","version":"1.2.3"}'),
	)
	zip.addFile('MultiplayerAPI/main.lua', Buffer.from('return {}'))
	return zip.toBuffer()
}

afterEach(() => vi.unstubAllGlobals())

describe('hash carry-over', () => {
	it('gives the same hash for the proxy copy and the Thunderstore copy', async () => {
		const bytes = packageZip()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(bytes, { status: 200 })),
		)
		const viaGithub = await inspectModRelease(
			'MultiplayerAPI',
			'1.2.3',
			'https://github.com/o/r/releases/download/v1.2.3/MultiplayerAPI-1.2.3.zip',
			'thunderstore',
		)
		const viaThunderstore = await inspectModRelease(
			'MultiplayerAPI',
			'1.2.3',
			'https://thunderstore.io/package/download/BalatroMultiplayer/MultiplayerAPI/1.2.3/',
			'thunderstore',
		)

		expect(viaGithub).not.toBeNull()
		expect(viaGithub?.hash).toMatch(/^[0-9a-f]{64}$/)
		expect(viaThunderstore).toEqual(viaGithub)
	})
})
