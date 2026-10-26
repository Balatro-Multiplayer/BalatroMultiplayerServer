import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The repo's nginx config (docker-compose.yml mounts it into `nginx` and
// `moderation-lb`). The Notice says we do not store plain IP addresses, so no
// access log may record the client's address, and the proxies pass on only
// the address real_ip restored.
const CONFIGS = ['nginx/prod/server.conf', 'nginx/moderation-upstream.conf']
const LOG_FORMAT = 'nginx/snippets/log-format.conf'

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

// The body of each `server { ... }` block.
function serverBlocks(text: string): string[] {
	const blocks: string[] = []
	const start = /^server\s*\{/gm
	let match: RegExpExecArray | null
	while ((match = start.exec(text))) {
		let depth = 0
		for (let i = match.index; i < text.length; i++) {
			if (text[i] === '{') depth++
			if (text[i] === '}' && --depth === 0) {
				blocks.push(text.slice(match.index, i + 1))
				break
			}
		}
	}
	return blocks
}

describe('nginx config', () => {
	it('defines an access log format with no client address', () => {
		const format = /log_format\s+no_client_ip\s+([^;]+);/.exec(read(LOG_FORMAT))
		expect(format).not.toBeNull()
		expect(format![1]).not.toMatch(/\$(remote_addr|binary_remote_addr|realip_remote_addr|http_x_forwarded_for|proxy_add_x_forwarded_for|http_cf_connecting_ip|http_x_real_ip|request\b|args|query_string|request_uri)/)
	})

	for (const config of CONFIGS) {
		it(`${config}: every server logs with that format and loads it`, () => {
			const text = read(config)
			expect(text).toContain('include /etc/nginx/snippets/log-format.conf;')
			const blocks = serverBlocks(text)
			expect(blocks.length).toBeGreaterThan(0)
			for (const block of blocks) expect(block).toMatch(/access_log\s+\S+\s+no_client_ip;/)
		})

		it(`${config}: X-Real-IP is the restored address, never a header the client can send`, () => {
			for (const line of read(config).split('\n').filter((l) => l.includes('X-Real-IP')))
				expect(line.trim()).toBe('proxy_set_header X-Real-IP $remote_addr;')
		})
	}
})
