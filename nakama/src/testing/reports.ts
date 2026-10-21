// Mod reports for tests that aren't about standing: a player with no report
// this session may not queue, so give each one a vanilla (all-allowed) report.
import { writeModReport } from '../standing/storage'
import type { FakeNk } from './fake_nk'

export function reportVanilla(nk: FakeNk, ...userIds: string[]) {
	for (const userId of userIds) writeModReport(nk as any, userId, { mods: [], reportedAt: 0 })
}
