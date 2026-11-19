// One-off: loads the Beta Seasons (the ranked seasons of the Discord queue era)
// from an import file and replaces the beta_season_* tables with it. Run it
// where PLAYER_ID_SALT is the live one, so the stored hashes match
// players.discord_id_hash:
//   node dist/scripts/import-beta-seasons.js < beta-seasons.ndjson
// The file is one JSON record per line (features/beta-seasons/import-records.ts):
//   {"kind":"season","number":1,"name":"Beta Season 1","startedAt":null,"endedAt":"..."}
//   {"kind":"standing","season":1,"modId":"MultiplayerPvP","gameMode":"ranked:pvp_ranked_expanded","discordId":"...",...}
//   {"kind":"game","season":2,"modId":"MultiplayerPvP","gameMode":"...","matchKey":"...","discordId":"...",...}
// Raw Discord ids are hashed before they are written, so none is stored.
// The file is checked in full before anything is written; one bad line fails
// the run. Safe to run again: each run replaces all three tables in one
// transaction.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import {
	type BetaRow,
	parseBetaRecord,
	toRow,
} from '../features/beta-seasons/import-records.js'
import { replaceBetaSeasons } from '../infrastructure/gateways/beta-seasons.gateway.js'
import { hashProviderId } from '../shared/utils/hash.js'

const TAG = '[beta-seasons]'

function lines(path: string | undefined) {
	const input = path ? createReadStream(path) : process.stdin
	return createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
}

// Pass 1: every line must parse. Stdin cannot be read twice, so a stdin run
// keeps the parsed rows; a file run reads the file again in pass 2.
async function checkAll(
	path: string | undefined,
	keep: BetaRow[] | null,
): Promise<number> {
	let bad = 0
	let n = 0
	const seen = new Set<string>()
	for await (const line of lines(path)) {
		n++
		if (!line.trim()) continue
		const parsed = parseBetaRecord(line)
		if (!parsed.ok) {
			if (bad++ < 20) console.error(`${TAG} line ${n}: bad ${parsed.error}`)
			continue
		}
		const r = parsed.value
		const key =
			r.kind === 'season'
				? `season:${r.number}`
				: r.kind === 'standing'
					? `standing:${r.season}:${r.modId}:${r.gameMode}:${r.discordId}`
					: `game:${r.season}:${r.matchKey}:${r.discordId}`
		if (seen.has(key)) {
			if (bad++ < 20) console.error(`${TAG} line ${n}: duplicate ${r.kind}`)
			continue
		}
		seen.add(key)
		keep?.push(toRow(r, hashProviderId))
	}
	return bad
}

async function* rowsOf(path: string): AsyncGenerator<BetaRow> {
	for await (const line of lines(path)) {
		if (!line.trim()) continue
		const parsed = parseBetaRecord(line)
		if (parsed.ok) yield toRow(parsed.value, hashProviderId)
	}
}

async function* fromArray(rows: BetaRow[]): AsyncGenerator<BetaRow> {
	yield* rows
}

async function main(): Promise<number> {
	const path = process.argv[2]
	const kept: BetaRow[] | null = path ? null : []
	const bad = await checkAll(path, kept)
	if (bad > 0) {
		console.error(`${TAG} ${bad} bad line(s); nothing written`)
		return 1
	}
	const counts = await replaceBetaSeasons(
		path ? rowsOf(path) : fromArray(kept ?? []),
	)
	console.log(
		`${TAG} Wrote ${counts.seasons} season(s), ${counts.standings} standing(s), ${counts.games} game row(s)`,
	)
	return 0
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(`${TAG} Failed (one transaction, so nothing changed):`, err)
		process.exit(1)
	})
