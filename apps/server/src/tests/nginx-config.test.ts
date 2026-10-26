import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// The error log keeps the client's address (it is how we debug a failed
// request), so the Notice promises no line of it is older than 7 days. nginx
// writes it to a file on a tmpfs (gone when the container stops), and
// nginx/rotate-error-log.sh, started by the image's entrypoint, rotates it
// every ROTATE_SECONDS and deletes each rotated file KEEP_SECONDS after its
// rotation (by the time in its name, so a file nginx still writes to goes too).
describe('nginx error log', () => {
	const ERROR_DIR = '/var/log/nginx/errors'
	const MAIN = 'nginx/nginx.conf'
	const ROTATE = 'nginx/rotate-error-log.sh'

	// The text of one service in docker-compose.yml.
	function service(name: string): string {
		const text = read('docker-compose.yml')
		const start = text.indexOf(`\n  ${name}:\n`)
		expect(start).toBeGreaterThan(-1)
		const rest = text.slice(start + 1)
		const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
		return next === -1 ? rest : rest.slice(0, next + 1)
	}

	it('writes the only error log to the tmpfs directory', () => {
		const text = read(MAIN)
		const main = text.slice(0, text.search(/^http\s*\{/m))
		expect(main).toMatch(new RegExp(`^error_log\\s+${ERROR_DIR}/error\\.log\\s+\\w+;`, 'm'))
		expect(text).toContain('include /etc/nginx/conf.d/*.conf;')
		// Only server blocks with no_client_ip write the access log.
		expect(text).toMatch(/^\s*access_log\s+off;/m)
		expect(text).not.toMatch(/\$remote_addr/)
		for (const config of [MAIN, ...CONFIGS]) {
			const lines = read(config).split('\n').filter((l) => /^\s*error_log\s/.test(l))
			for (const line of lines) expect(line.trim()).toMatch(new RegExp(`^error_log\\s+${ERROR_DIR}/`))
		}
	})

	it('deletes every error log line before it is 7 days old', () => {
		const script = read(ROTATE)
		const value = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(script)?.[1])
		const rotateSeconds = value('ROTATE_SECONDS')
		const keepSeconds = value('KEEP_SECONDS')
		expect(rotateSeconds).toBeGreaterThan(0)
		expect(keepSeconds).toBeGreaterThan(0)
		// A line waits at most one rotation to leave error.log, and its file is
		// deleted at the first pass past KEEP_SECONDS; passes are one rotation
		// apart.
		expect(keepSeconds + 2 * rotateSeconds).toBeLessThan(7 * 24 * 60 * 60)
		expect(script).toContain(`DIR=\${ERROR_LOG_DIR:-${ERROR_DIR}}`)
	})

	it('one pass rotates error.log, has nginx reopen it, and deletes the rotated files past the limit', () => {
		const dir = mkdtempSync(join(tmpdir(), 'nginx-errors-'))
		const bin = mkdtempSync(join(tmpdir(), 'nginx-bin-'))
		try {
			// A stand-in nginx that records how it was called.
			writeFileSync(join(bin, 'nginx'), `#!/bin/sh\necho "$@" >> ${join(dir, 'calls')}\n`, { mode: 0o755 })
			const now = Math.floor(Date.now() / 1000)
			const keep = Number(/^KEEP_SECONDS=(\d+)$/m.exec(read(ROTATE))?.[1])
			writeFileSync(join(dir, 'error.log'), 'client: 192.0.2.1\n')
			writeFileSync(join(dir, `error.log.${now - keep - 10}`), 'old\n')
			writeFileSync(join(dir, `error.log.${now - keep + 600}`), 'recent\n')
			execFileSync('sh', [fileURLToPath(new URL(`../../../../${ROTATE}`, import.meta.url)), 'once'], {
				env: { ...process.env, ERROR_LOG_DIR: dir, PATH: `${bin}:${process.env.PATH}` },
			})
			const files = readdirSync(dir).sort()
			expect(files).not.toContain('error.log')
			expect(files).not.toContain(`error.log.${now - keep - 10}`)
			expect(files).toContain(`error.log.${now - keep + 600}`)
			expect(files.filter((f) => /^error\.log\.\d+$/.test(f))).toHaveLength(2)
			expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('-s reopen\n')
		} finally {
			rmSync(dir, { recursive: true, force: true })
			rmSync(bin, { recursive: true, force: true })
		}
	})

	for (const name of ['nginx', 'moderation-lb']) {
		it(`docker-compose.yml ${name}: uses that config, the tmpfs and the rotation`, () => {
			const text = service(name)
			expect(text).toContain('- ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro')
			expect(text).toContain('- ./nginx/rotate-error-log.sh:/docker-entrypoint.d/90-rotate-error-log.sh:ro')
			expect(text).toMatch(new RegExp(`tmpfs:\\n\\s+- ${ERROR_DIR}:`))
		})
	}
})
