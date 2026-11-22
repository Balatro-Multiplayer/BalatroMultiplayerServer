// The cards that hit other players (Asteroid, Pizza, Gambling). A player's game sends how
// many of each it has played this run; the server hands every player it reaches one inbox
// item per new play. Who is reached comes from opponent_targets.ts.

import type { InputHandler } from '../core/apply'
import { addInboxItem } from '../core/inbox'
import type { PlayerId, State } from '../core/types'
import { type Reach, reachedBy } from '../rules/opponent_targets'
import { isInRun } from '../rules/players'

export type EffectInput = {
	kind: 'effect'
	effect: EffectName
	total: number
}

export const MAX_EFFECTS_PER_PLAYER = 384

const EFFECT_NAMES = ['asteroid', 'pizza', 'gambling'] as const
type EffectName = (typeof EFFECT_NAMES)[number]

const EFFECTS: { [effect in EffectName]: { reach: Reach; amount: number } } = {
	asteroid: { reach: 'targeting me', amount: 1 },
	pizza: { reach: 'everyone', amount: 1 },
	gambling: { reach: 'everyone', amount: 10 },
}

const effectSpec = {
	effect: { type: 'oneOf', values: EFFECT_NAMES },
	total: { type: 'whole', max: MAX_EFFECTS_PER_PLAYER },
} as const

function hit(
	state: State,
	from: PlayerId,
	effect: EffectName,
	times: number,
	ante: number,
): State {
	const { reach, amount } = EFFECTS[effect]
	let next = state
	for (const target of reachedBy(state, from, reach))
		for (let count = 0; count < times; count++)
			next = addInboxItem(
				next,
				target,
				effect === 'pizza'
					? { from, effect, amount, ante }
					: { from, effect, amount },
			)
	return next
}

export const effectHandler: InputHandler<typeof effectSpec> = {
	spec: effectSpec,
	handle(state, player, body, _now, previousTotal) {
		const run = state.run
		const ante = run?.players[player]?.ante
		if (run === null || ante === null || ante === undefined)
			return { refusal: 'no_progress' }
		if (!isInRun(run, player)) return { refusal: 'eliminated' }
		return hit(
			state,
			player,
			body.effect,
			body.total - (previousTotal ?? 0),
			ante,
		)
	},
}
