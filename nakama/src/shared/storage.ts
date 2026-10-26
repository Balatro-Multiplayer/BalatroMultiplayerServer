const LIST_PAGE = 100

// Calls visit on each object of a collection, a storage page at a time
// (owner null: every owner). visit returns 'stop' to end early. Returns
// true when it stopped early.
export function forEachStored(
	nk: nkruntime.Nakama,
	owner: string | null,
	collection: string,
	visit: (object: nkruntime.StorageObject) => 'stop' | void,
): boolean {
	let cursor = ''
	do {
		const page = nk.storageList(owner, collection, LIST_PAGE, cursor)
		for (const o of page.objects || []) if (visit(o) === 'stop') return true
		cursor = page.cursor || ''
	} while (cursor)
	return false
}
