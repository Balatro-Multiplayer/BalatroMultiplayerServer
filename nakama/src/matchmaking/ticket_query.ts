// Whether a matchmaker ticket only asks for the queue it says it is in. The
// matchmaker runs one-sided (no rev_precision), so a ticket's query alone
// decides whom it may pull in: a query that doesn't pin its own modId and
// mode could match another mod's tickets and spend them (planMatch refuses
// the mixed group, but those players' tickets are gone). Pure.
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const KINDS = ['casual', 'ranked'] as const

export type TicketQueryRefusal = 'bad_properties' | 'query_not_pinned'

export const TICKET_QUERY_MESSAGES: { [code in TicketQueryRefusal]: string } = {
	bad_properties: 'The ticket does not name a queue',
	query_not_pinned: 'The ticket does not match its queue',
}

function isKind(value: unknown): boolean {
	return KINDS.some((k) => k === value)
}

function requiredClauses(query: string): string[] {
	return query.split(/\s+/).filter((term) => term.charAt(0) === '+')
}

// kind may be left out (a group ticket is casual either way); when present
// it must be a known kind.
export function ticketQueryRefusal(query: unknown, props: { [key: string]: unknown }): TicketQueryRefusal | null {
	const { modId, mode, kind } = props
	if (typeof modId !== 'string' || !QUEUE_NAME_PATTERN.test(modId)) return 'bad_properties'
	if (typeof mode !== 'string' || !QUEUE_NAME_PATTERN.test(mode)) return 'bad_properties'
	if (kind !== undefined && !isKind(kind)) return 'bad_properties'
	if (typeof query !== 'string') return 'query_not_pinned'
	const clauses = requiredClauses(query)
	if (clauses.indexOf('+properties.modId:' + modId) === -1) return 'query_not_pinned'
	if (clauses.indexOf('+properties.mode:' + mode) === -1) return 'query_not_pinned'
	return null
}
