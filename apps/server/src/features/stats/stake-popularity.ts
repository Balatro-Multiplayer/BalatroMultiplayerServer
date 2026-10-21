// §6.2 Stake Popularity buckets, from match counts per (modId, gameMode).
// Pure. A gameMode only names a stake for SPDRN's two fixed-stake formats;
// every other one is "Other". Buckets are kept per mod as well as summed, so
// one mod's modes never land in another's figures.
export type StakeBucket = 'White Stake' | 'Gold Stake' | 'Other'
export type StakeBuckets = Record<StakeBucket, number>

export interface ModeCount {
	modId: string
	gameMode: string
	count: number
}

export interface StakePopularity {
	buckets: StakeBuckets
	byMod: Record<string, StakeBuckets>
	coarse: true
}

const emptyBuckets = (): StakeBuckets => ({ 'White Stake': 0, 'Gold Stake': 0, Other: 0 })

export function stakeBucketOf(gameMode: string): StakeBucket {
	if (gameMode.includes('white_stake_triple')) return 'White Stake'
	if (gameMode.includes('gold_stake_single')) return 'Gold Stake'
	return 'Other'
}

export function stakePopularity(rows: ModeCount[]): StakePopularity {
	const buckets = emptyBuckets()
	const byMod: Record<string, StakeBuckets> = {}
	for (const row of rows) {
		const bucket = stakeBucketOf(row.gameMode)
		const mod = byMod[row.modId] || (byMod[row.modId] = emptyBuckets())
		mod[bucket] += row.count
		buckets[bucket] += row.count
	}
	return { buckets, byMod, coarse: true }
}
