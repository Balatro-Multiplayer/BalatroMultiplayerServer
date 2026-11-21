// The display names of the ranked boards: the Leaderboards page and the season
// end Notification both read them, so a board is called the same thing in both.
// `modes` are keyed by the game mode WITHOUT the `ranked:` prefix.

export interface BoardMods {
	[modId: string]: { label: string; modes: { [mode: string]: string } }
}

export const BOARD_NAMES = {
	MultiplayerSPDRN: {
		label: 'Speedrun',
		modes: {
			spdrn_white_stake_triple: 'White Stake Triple',
			spdrn_gold_stake_single: 'Gold Stake Single',
		},
	},
	MultiplayerPvP: {
		label: 'PvP',
		modes: {
			pvp_ranked_vanilla: 'Vanilla',
			pvp_ranked_balanced: 'Balanced',
			pvp_ranked_expanded: 'Expanded',
			pvp_ranked_majorleague: 'MLBa',
			pvp_ranked_smallworld: 'Smallworld',
		},
	},
} as const satisfies BoardMods

// "PvP Vanilla" for a known board, undefined when the mod or the mode has no
// display name (the caller decides what to do; a raw key is never shown).
export function boardName(modId: string, gameMode: string): string | undefined {
	// Own keys only: '__proto__' or 'constructor' must not find Object's.
	const mods: BoardMods = BOARD_NAMES
	if (!Object.hasOwn(mods, modId)) return undefined
	const mod = mods[modId]
	const modeKey = gameMode.replace(/^ranked:/, '')
	if (!Object.hasOwn(mod.modes, modeKey)) return undefined
	return `${mod.label} ${mod.modes[modeKey]}`
}
