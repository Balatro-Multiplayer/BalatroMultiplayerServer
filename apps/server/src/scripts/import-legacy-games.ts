// One-off: loads the legacy game logs (games from the legacy website's
// uploaded logs, in the replay event format) from an import file and replaces
// legacy_game_logs with it. Run it where PLAYER_ID_SALT is the live one, so the
// stored hashes match players.discord_id_hash:
//   node dist/scripts/import-legacy-games.js legacy-games.ndjson
// One JSON record per line (features/legacy-games/import-records.ts). Raw
// Discord ids are hashed before they are written, so none is stored. The file
// is checked in full before anything is written; one bad line fails the run.
// Safe to run again: each run replaces the table in one transaction and keeps
// the games' shares.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import {
	type LegacyGameInsert,
	parseLegacyGameRecord,
	toInsert,
} from '../features/legacy-games/import-records.js'
import { replaceLegacyGames } from '../infrastructure/gateways/legacy-games.gateway.js'
import { hashProviderId } from '../shared/utils/hash.js'

const TAG = '[legacy-games]'

function lines(path: string) {
	return createInterface({
		input: createReadStream(path),
		crlfDelay: Number.POSITIVE_INFINITY,
	})
}

async function checkAll(path: string): Promise<number> {
	let bad = 0
	let n = 0
	const seen = new Set<number>()
	for await (const line of lines(path)) {
		n++
		if (!line.trim()) continue
		const parsed = parseLegacyGameRecord(line)
		if (!parsed.ok) {
			if (bad++ < 20) console.error(`${TAG} line ${n}: bad ${parsed.error}`)
			continue
		}
		if (seen.has(parsed.value.id)) {
			if (bad++ < 20) console.error(`${TAG} line ${n}: duplicate id`)
			continue
		}
		seen.add(parsed.value.id)
	}
	return bad
}

async function* rowsOf(path: string): AsyncGenerator<LegacyGameInsert> {
	const hashes = new Map<string, string>()
	const hash = (id: string) => {
		const known = hashes.get(id)
		if (known) return known
		const h = hashProviderId(id)
		hashes.set(id, h)
		return h
	}
	for await (const line of lines(path)) {
		if (!line.trim()) continue
		const parsed = parseLegacyGameRecord(line)
		if (parsed.ok) yield toInsert(parsed.value, hash)
	}
}

async function main(): Promise<number> {
	const path = process.argv[2]
	if (!path) {
		console.error(`${TAG} usage: import-legacy-games.js <file.ndjson>`)
		return 1
	}
	const bad = await checkAll(path)
	if (bad > 0) {
		console.error(`${TAG} ${bad} bad line(s); nothing written`)
		return 1
	}
	const n = await replaceLegacyGames(rowsOf(path))
	console.log(`${TAG} Wrote ${n} game(s)`)
	return 0
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(`${TAG} Failed (one transaction, so nothing changed):`, err)
		process.exit(1)
	})
