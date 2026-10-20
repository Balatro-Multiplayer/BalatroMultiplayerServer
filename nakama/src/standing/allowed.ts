// Which SMODS ids a mod report may list. Pure.
import type { ServerConfig } from '../config'

// The platform itself, allowed whatever is pinned: Steamodded's own pseudo
// mods (SMODS.Mods.Balatro / .Lovely) and Steamodded.
export const BASELINE_MOD_IDS: readonly string[] = ['Balatro', 'Steamodded', 'Lovely']

// The baseline, the pinned mods' ids the API pushes, and the local-only
// extra ids (test clients' dev mods), each once.
export function allowedModIds(
	config: Pick<ServerConfig, 'queueAllowedModIds' | 'queueAllowedModIdsExtra'>,
): string[] {
	const out: string[] = []
	for (const id of BASELINE_MOD_IDS.concat(config.queueAllowedModIds, config.queueAllowedModIdsExtra)) {
		if (out.indexOf(id) === -1) out.push(id)
	}
	return out
}

// Whether a config change can move anyone's standing.
export function standingInputsChanged(
	before: Pick<ServerConfig, 'queueModsEnforced' | 'queueAllowedModIds' | 'queueAllowedModIdsExtra'>,
	after: Pick<ServerConfig, 'queueModsEnforced' | 'queueAllowedModIds' | 'queueAllowedModIdsExtra'>,
): boolean {
	if (before.queueModsEnforced !== after.queueModsEnforced) return true
	const a = allowedModIds(before)
	const b = allowedModIds(after)
	return a.length !== b.length || a.some((id) => b.indexOf(id) === -1)
}
