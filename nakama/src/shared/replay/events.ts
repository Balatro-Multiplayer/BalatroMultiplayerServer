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

function eventOf(tuple: unknown): LogEvent | null {
	if (!Array.isArray(tuple) || typeof tuple[1] !== 'string') return null
	return { t: typeof tuple[0] === 'number' ? tuple[0] : 0, opcode: tuple[1], args: tuple[2] ?? null }
}

function eventsOfTuples(tuples: unknown[]): LogEvent[] {
	const events: LogEvent[] = []
	for (const tuple of tuples) {
		const event = eventOf(tuple)
		if (event) events.push(event)
	}
	return events
}

export function eventsOf(log: PlayerLog | undefined): LogEvent[] {
	if (!log) return []
	return eventsOfTuples(log.lines.map((line) => JSON.parse(line) as unknown))
}

// A log as stored in match_logs (lobby/storage.ts writes the tuples parsed).
export function eventsOfStored(value: unknown): LogEvent[] {
	const events = value !== null && typeof value === 'object' ? (value as { events?: unknown }).events : undefined
	return Array.isArray(events) ? eventsOfTuples(events) : []
}

export function eventsByPlayer(logs: { [userId: string]: PlayerLog }): { [userId: string]: LogEvent[] } {
	const events: { [userId: string]: LogEvent[] } = {}
	for (const userId in logs) events[userId] = eventsOf(logs[userId])
	return events
}
