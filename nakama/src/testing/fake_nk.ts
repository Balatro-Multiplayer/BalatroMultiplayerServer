// Test double for the slice of nkruntime.Nakama the module uses: an in-memory
// storage with Nakama's version rules ('*' = must not exist, otherwise the
// versions must match), recorded notifications and http calls. Pass
// overrides for anything a test needs to script.
export interface FakeNk {
	objects: Map<string, { value: any; version: number }>
	notifications: { userId: string; subject: string; content: any; code: number; persistent: boolean }[]
	http: { url: string; method: string; headers: any; body: string }[]
	[key: string]: any
}

export function fakeNk(overrides: { [key: string]: unknown } = {}): FakeNk {
	const objects = new Map<string, { value: any; version: number }>()
	const k = (c: string, u: string, key: string) => `${c}/${u}/${key}`
	const nk: FakeNk = {
		objects,
		notifications: [],
		http: [],
		storageRead: (reads: any[]) =>
			reads.flatMap((r) => {
				const o = objects.get(k(r.collection, r.userId, r.key))
				return o ? [{ ...r, value: o.value, version: String(o.version) }] : []
			}),
		storageWrite: (writes: any[]) => {
			for (const w of writes) {
				const e = objects.get(k(w.collection, w.userId, w.key))
				const ok = w.version === undefined || (w.version === '*' ? !e : e && String(e.version) === w.version)
				if (!ok) throw new Error('version check failed')
			}
			for (const w of writes) {
				const key = k(w.collection, w.userId, w.key)
				objects.set(key, { value: w.value, version: (objects.get(key)?.version ?? 0) + 1 })
			}
		},
		storageDelete: (deletes: any[]) => {
			for (const d of deletes) objects.delete(k(d.collection, d.userId, d.key))
		},
		// userId null lists the collection across every owner, as Nakama does.
		storageList: (userId: string | null, collection: string) => ({
			objects: [...objects.entries()]
				.map(([key, o]) => {
					const [c, u, ...rest] = key.split('/')
					return { collection: c, userId: u, key: rest.join('/'), value: o.value, version: String(o.version) }
				})
				.filter((o) => o.collection === collection && (userId === null || o.userId === userId)),
			cursor: '',
		}),
		notificationSend: (userId: string, subject: string, content: any, code: number, _sender: string, persistent: boolean) => {
			nk.notifications.push({ userId, subject, content, code, persistent })
		},
		httpRequest: (url: string, method: string, headers: any, body: string) => {
			nk.http.push({ url, method, headers, body })
			return { code: 200, headers: {}, body: '{}' }
		},
		...overrides,
	}
	return nk
}

export const fakeLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
} as unknown as nkruntime.Logger

export const serverCtx = (env: { [key: string]: string } = {}) =>
	({ userId: '', username: '', matchId: '', env }) as nkruntime.Context

export const playerCtx = (userId: string, env: { [key: string]: string } = {}) =>
	({ userId, username: userId, matchId: '', env }) as nkruntime.Context
