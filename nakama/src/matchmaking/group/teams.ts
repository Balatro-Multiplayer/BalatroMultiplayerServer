// Splitting a matched Teams game into its two teams without breaking up a
// group: pure, so a made match always agrees with what the groups asked for.
import { err, ok, type Result } from '../../shared/result'

export type TeamPlan = [string[], string[]]

export type PartitionRefusal =
	// An odd number of players can't make two equal teams.
	| 'odd_players'
	// No way to make two equal teams keeping every group whole.
	| 'groups_unsplittable'

// The two teams, each half the players, every group (a solo player is a
// group of one) on one team. Bigger groups are placed first and the first
// team is filled from the earliest-matched groups, so the same match always
// splits the same way.
export function partitionTeams(groups: string[][]): Result<TeamPlan, PartitionRefusal> {
	const total = groups.reduce((n, g) => n + g.length, 0)
	if (total % 2 !== 0) return err('odd_players')
	const half = total / 2
	const order = groups
		.map((members, index) => ({ members, index }))
		.sort((a, b) => b.members.length - a.members.length || a.index - b.index)
	// reach[s]: the groups (by position in order) that first sum to s.
	const reach: (number[] | null)[] = [[]]
	for (let s = 1; s <= half; s++) reach.push(null)
	for (let i = 0; i < order.length; i++) {
		const size = order[i].members.length
		for (let s = half; s >= size; s--) {
			const from = reach[s - size]
			if (reach[s] === null && from !== null && from.indexOf(i) === -1) reach[s] = from.concat([i])
		}
	}
	const chosen = reach[half]
	if (chosen === null) return err('groups_unsplittable')
	const first: string[] = []
	const second: string[] = []
	order.forEach((g, i) => {
		const team = chosen.indexOf(i) !== -1 ? first : second
		for (const id of g.members) team.push(id)
	})
	return ok([first, second])
}
