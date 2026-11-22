// The match state as Nakama's JS runtime hands it back between calls: every read of an object
// or array inside it is a new object, so two reads of the same item are never `===`. A rule
// that finds an item by identity works on plain test data and fails live; run it on this.
export function copyOnRead<T>(value: T): T {
	if (typeof value !== 'object' || value === null) return value
	return new Proxy(value, {
		get(target, key, receiver) {
			return copyOnRead(Reflect.get(target, key, receiver))
		},
	})
}
