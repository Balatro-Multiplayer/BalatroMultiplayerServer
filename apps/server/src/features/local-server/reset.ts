// Wipes a Community or Dev server back to empty (compose.local.yml's `reset`
// service): both databases are dropped, then the API's is made again and
// migrated. Nakama's own `migrate up` makes its database again when it next
// starts, so Nakama and the API must be restarted afterwards. Never on the
// Official server.
import type { ServerKind } from '@bmp/types'
import { type Result, err, ok } from '../../shared/utils/result.js'

export interface ResetDeps {
	kind: ServerKind
	apiDatabase: string
	nakamaDatabase: string
	dropDatabase(name: string): Promise<void>
	createDatabase(name: string): Promise<void>
	migrate(): Promise<void>
}

export type ResetError = { kind: 'official_server' }

export async function runReset(
	deps: ResetDeps,
): Promise<Result<void, ResetError>> {
	if (deps.kind === 'official') return err({ kind: 'official_server' })

	await deps.dropDatabase(deps.nakamaDatabase)
	await deps.dropDatabase(deps.apiDatabase)
	await deps.createDatabase(deps.apiDatabase)
	await deps.migrate()
	return ok(undefined)
}
