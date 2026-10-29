// Closes the open anti-cheat queue items of the repaired games as the owner. A
// dismiss makes the queue write its usual audit event.

export interface DismissDeps {
	// Ids of the open anti-cheat items about these runs.
	listOpenItems(runIds: string[]): Promise<number[]>
	dismiss(
		itemId: number,
		actor: { playerId: string; role: 'admin' },
		note: string,
	): Promise<{ ok: boolean }>
}

export async function dismissAntiCheatItems(
	runIds: string[],
	note: string,
	owner: string,
	deps: DismissDeps,
): Promise<{ dismissed: number; failed: number }> {
	let dismissed = 0
	let failed = 0
	for (const id of await deps.listOpenItems(runIds)) {
		const result = await deps.dismiss(
			id,
			{ playerId: owner, role: 'admin' },
			note,
		)
		if (result.ok) dismissed++
		else failed++
	}
	return { dismissed, failed }
}
