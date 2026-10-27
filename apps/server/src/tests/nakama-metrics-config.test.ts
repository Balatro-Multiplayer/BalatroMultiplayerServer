import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Nakama's Prometheus port (nakama/*.yml metrics.prometheus_port) feeds the
// Stats page's online player count. Only the API reads it, over the compose
// network: no compose file may publish it to the host.
const read = (path: string) =>
	readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

function prometheusPort(config: string): number | null {
	const match =
		/^metrics:\n(?:[ \t]+.*\n|\n)*?[ \t]+prometheus_port:\s*(\d+)/m.exec(
			read(config),
		)
	return match ? Number(match[1]) : null
}

const COMPOSE_FILES = [
	'docker-compose.yml',
	'docker-compose.balatro.yml',
	'compose.local.yml',
]

describe('Nakama metrics port', () => {
	const port = prometheusPort('nakama/prod.yml')

	it('is on in both Nakama configs, on the same port', () => {
		expect(port).not.toBeNull()
		expect(prometheusPort('nakama/local.yml')).toBe(port)
	})

	it.each(COMPOSE_FILES)('is not published to the host in %s', (file) => {
		expect(read(file)).not.toMatch(
			new RegExp(`:${port}(?:/tcp)?["']?\\s*$`, 'm'),
		)
	})

	it.each(['docker-compose.yml', 'compose.local.yml'])(
		'is what the API reads in %s',
		(file) => {
			expect(read(file)).toContain(`NAKAMA_METRICS_URL: http://nakama:${port}/`)
		},
	)
})
