import { describe, expect, it } from 'vitest'
import { settingsFor } from '../testing/fake_nk'
import { networkOf, requireIpHashSalt } from './network'

// Documentation ranges (RFC 5737, RFC 3849) only.
describe('networkOf', () => {
	it('is the whole address for IPv4', () => {
		expect(networkOf('192.0.2.17')).toBe('192.0.2.17')
	})

	it('is the /64 prefix for IPv6, so two hosts on one network match', () => {
		expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
		expect(networkOf('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(
			'2001:db8:1:2::/64',
		)
	})

	it('expands a compressed IPv6 address before taking the prefix', () => {
		expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
		expect(networkOf('::1')).toBe('0:0:0:0::/64')
	})

	it('treats an IPv4-mapped IPv6 address as IPv4', () => {
		expect(networkOf('::ffff:192.0.2.17')).toBe('192.0.2.17')
	})

	it('drops a port or an IPv6 zone', () => {
		expect(networkOf('192.0.2.17:4000')).toBe('192.0.2.17')
		expect(networkOf('[2001:db8:1:2::1]:4000')).toBe('2001:db8:1:2::/64')
		expect(networkOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
	})

	it('is null for anything that is not an IP address', () => {
		for (const bad of [
			'',
			'localhost',
			'256.0.0.1',
			'1.2.3',
			'2001:db8:::1',
			'1:2:3:4:5:6:7:8:9',
		])
			expect(networkOf(bad)).toBeNull()
	})
})

describe('requireIpHashSalt', () => {
	it('refuses to start a server with network bans and no IP_HASH_SALT', () => {
		expect(() => requireIpHashSalt(settingsFor('official'), {})).toThrow(
			/IP_HASH_SALT/,
		)
		expect(() =>
			requireIpHashSalt(settingsFor('official'), { IP_HASH_SALT: 's' }),
		).not.toThrow()
	})

	it('needs no salt on a server without network bans', () => {
		expect(() => requireIpHashSalt(settingsFor('community'), {})).not.toThrow()
		expect(() => requireIpHashSalt(settingsFor('dev'), {})).not.toThrow()
	})
})
