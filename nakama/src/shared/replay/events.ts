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

// A log as stored in match_logs: the exact lines (lobby/storage.ts), parsed on
// read. A log stored before that kept parsed `events` instead.
export function tuplesOfStored(value: unknown): unknown[] {
	if (value === null || typeof value !== 'object') return []
	const { lines, events } = value as { lines?: unknown; events?: unknown }
	if (Array.isArray(lines)) return lines.map((line) => JSON.parse(String(line)) as unknown)
	return Array.isArray(events) ? events : []
}

export function eventsOfStored(value: unknown): LogEvent[] {
	return eventsOfTuples(tuplesOfStored(value))
}

export function eventsByPlayer(logs: { [userId: string]: PlayerLog }): { [userId: string]: LogEvent[] } {
	const events: { [userId: string]: LogEvent[] } = {}
	for (const userId in logs) events[userId] = eventsOf(logs[userId])
	return events
}
