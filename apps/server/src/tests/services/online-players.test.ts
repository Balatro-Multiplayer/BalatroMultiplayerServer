import { describe, expect, it } from 'vitest'
import { parseNakamaSessions } from '../../features/stats/online-players.js'

// Shaped like Nakama 3.41's Prometheus endpoint: tally prefixes every metric
// with "nakama" and labels it with the node name.
const sampleBody = `# HELP nakama_api_count nakama_api_count counter
# TYPE nakama_api_count counter
nakama_api_count{node_name="nakama1"} 42
# HELP nakama_sessions nakama_sessions gauge
# TYPE nakama_sessions gauge
nakama_sessions{node_name="nakama1"} 7
# HELP nakama_sessions_total_overall made-up metric with the same prefix
# TYPE nakama_sessions_total_overall gauge
nakama_sessions_total_overall{node_name="nakama1"} 900
# HELP nakama_presences nakama_presences gauge
# TYPE nakama_presences gauge
nakama_presences{node_name="nakama1"} 12
`

describe('parseNakamaSessions', () => {
	it('reads the nakama_sessions gauge from a metrics body', () => {
		expect(parseNakamaSessions(sampleBody)).toBe(7)
	})

	it('answers 0 when the gauge is missing', () => {
		expect(
			parseNakamaSessions(
				'# TYPE nakama_api_count counter\nnakama_api_count{node_name="nakama1"} 42\n',
			),
		).toBe(0)
	})

	it('sums the gauge over several lines', () => {
		const body = `# TYPE nakama_sessions gauge
nakama_sessions{node_name="nakama1"} 3
nakama_sessions{node_name="nakama2"} 5
`
		expect(parseNakamaSessions(body)).toBe(8)
	})

	it('reads a gauge with no labels', () => {
		expect(parseNakamaSessions('nakama_sessions 4\n')).toBe(4)
	})
})
