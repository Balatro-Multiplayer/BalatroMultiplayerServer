// A stored replay log's events, parsed once per finished run and shared by
// everything that reads them (lobby/anticheat.ts, achievements/facts). Each
// line is the JSON text of a [t, opcode, args] tuple (actions/registry.ts
// writes it, so it always parses). Pure.
import type { PlayerLog } from '../../lobby/protocol'

export interface LogEvent {
	// ms since the client's begin_run (client-written).
	t: number
	opcode: string
	args: unknown
}

export function eventsOf(log: PlayerLog | undefined): LogEvent[] {
	if (!log) return []
	const events: LogEvent[] = []
	for (const line of log.lines) {
		const tuple = JSON.parse(line) as unknown[]
		if (!Array.isArray(tuple) || typeof tuple[1] !== 'string') continue
		events.push({ t: typeof tuple[0] === 'number' ? tuple[0] : 0, opcode: tuple[1], args: tuple[2] ?? null })
	}
	return events
}

export function eventsByPlayer(logs: { [userId: string]: PlayerLog }): { [userId: string]: LogEvent[] } {
	const events: { [userId: string]: LogEvent[] } = {}
	for (const userId in logs) events[userId] = eventsOf(logs[userId])
	return events
}
