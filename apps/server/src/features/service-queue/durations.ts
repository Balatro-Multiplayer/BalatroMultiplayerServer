// A preset duration as the ban it becomes: its end, or null for permanent.
import type { Duration } from './types.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const LENGTH_MS: Readonly<Record<Exclude<Duration, 'permanent'>, number>> = {
	'24h': 24 * HOUR_MS,
	'7d': 7 * DAY_MS,
	'30d': 30 * DAY_MS,
}

export function expiresAtOf(duration: Duration, now: Date): Date | null {
	return duration === 'permanent' ? null : new Date(now.getTime() + LENGTH_MS[duration])
}
