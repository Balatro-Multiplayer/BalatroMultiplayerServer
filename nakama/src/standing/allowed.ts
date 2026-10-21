// Which SMODS ids a mod report may list. Pure.
import { modIdsOf, type ServerConfig } from '../config'

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
	before: Pick<ServerConfig, 'queueAllowedModIds' | 'queueAllowedModIdsExtra'>,
	after: Pick<ServerConfig, 'queueAllowedModIds' | 'queueAllowedModIdsExtra'>,
): boolean {
	const a = allowedModIds(before)
	const b = allowedModIds(after)
	return a.length !== b.length || a.some((id) => b.indexOf(id) === -1)
}

// QUEUE_ALLOWED_MOD_IDS_EXTRA's value -- comma or whitespace separated ids --
// as a list; null when it's unset, empty or holds an id the config would
// refuse (so a typo seeds nothing rather than part of the list).
export function parseExtraSeed(value: string | undefined): string[] | null {
	if (value === undefined) return null
	const ids = value.split(/[\s,]+/).filter((id) => id !== '')
	if (ids.length === 0) return null
	return modIdsOf(ids)
}

// The extra ids with every seeded one present, each once; null when the seed
// adds nothing.
export function seededExtra(current: string[], seed: string[]): string[] | null {
	const missing = seed.filter((id, i) => current.indexOf(id) === -1 && seed.indexOf(id) === i)
	return missing.length > 0 ? current.concat(missing) : null
}
