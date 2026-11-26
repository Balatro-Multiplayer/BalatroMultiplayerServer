// A test client for a Community server (nakama/e2e/compose.e2e.yml): logs in
// with a test name through Device login (no Steam), reports a mod list so its
// standing is valid, and queues through the realtime socket's matchmaker as
// the game does. Node's own fetch and WebSocket; no Nakama client library.
import { MODE, MOD_ID, type Ranges, type Ticket } from './window'

export const BASE = process.env.E2E_NAKAMA_URL ?? 'http://127.0.0.1:17350'
const SERVER_KEY = 'defaultkey'
const HTTP_KEY = process.env.E2E_NAKAMA_HTTP_KEY ?? 'e2e-http-key'

// How long a pass of the matchmaker takes to be sure of (local.yml: 2s).
export const PASS_MS = 3500

// A server-to-server RPC (the http key), as the API calls Nakama.
export async function adminRpc(id: string, body: object): Promise<any> {
	const res = await fetch(`${BASE}/v2/rpc/${id}?http_key=${HTTP_KEY}&unwrap`, {
		method: 'POST',
		body: JSON.stringify(body),
	})
	const text = await res.text()
	if (!res.ok) throw new Error(`${id}: ${res.status} ${text}`)
	return text ? JSON.parse(text) : {}
}

// The season ratings are read from, and the ranges the website would have set
// (instantQueue is keyed 'modId:mode').
export async function configure(ranges: Ranges | null): Promise<void> {
	await adminRpc('admin_config_set', {
		season: 1,
		instantQueue: ranges ? { [`${MOD_ID}:${MODE}`]: ranges } : {},
	})
}

export class TestClient {
	userId = ''
	token = ''
	ticket: string | null = null
	// Every matchmaker_matched this client got.
	matched: any[] = []
	private ws!: WebSocket
	private cid = 0
	private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
	private waiters: (() => void)[] = []

	constructor(readonly name: string) {}

	// Logs in (the account is made the first time) and opens the socket.
	async connect(): Promise<this> {
		const auth = await fetch(`${BASE}/v2/account/authenticate/device?create=true&username=${this.name}`, {
			method: 'POST',
			headers: { Authorization: 'Basic ' + Buffer.from(`${SERVER_KEY}:`).toString('base64') },
			body: JSON.stringify({ id: `bmp-dev-${this.name}` }),
		})
		if (!auth.ok) throw new Error(`login ${this.name}: ${auth.status} ${await auth.text()}`)
		this.token = (await auth.json()).token
		this.userId = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64url').toString()).uid
		await this.rpc('session_init', { steamName: this.name })
		// What the game reports at login; a Community server allows any mods.
		await this.rpc('profile_set_mods', { mods: [MOD_ID, 'Steamodded'] })
		const wsUrl = BASE.replace(/^http/, 'ws')
		this.ws = new WebSocket(`${wsUrl}/ws?token=${this.token}&format=json&status=false`)
		this.ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)))
		await new Promise<void>((resolve, reject) => {
			this.ws.onopen = () => resolve()
			this.ws.onerror = () => reject(new Error(`socket ${this.name}`))
		})
		return this
	}

	async rpc(id: string, body: object): Promise<any> {
		const res = await fetch(`${BASE}/v2/rpc/${id}?unwrap`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.token}` },
			body: JSON.stringify(body),
		})
		const text = await res.text()
		if (!res.ok) throw new Error(`${this.name} ${id}: ${res.status} ${text}`)
		return text ? JSON.parse(text) : {}
	}

	// A rating on the queue's board, as the API's rating push writes it.
	async setRating(rating: number): Promise<void> {
		await adminRpc('admin_ratings_set', {
			modId: MOD_ID,
			mode: MODE,
			season: 1,
			entries: [
				{
					userId: this.userId,
					name: this.name,
					record: { rating, wins: 10, losses: 10, gamesPlayed: 20, seasonBest: null, lastMatchAt: Date.now() },
				},
			],
		})
	}

	private onMessage(msg: any) {
		if (msg.cid && this.pending.has(msg.cid)) {
			const p = this.pending.get(msg.cid)!
			this.pending.delete(msg.cid)
			if (msg.error) p.reject(new Error(`${this.name}: ${msg.error.message}`))
			else p.resolve(msg)
			return
		}
		if (msg.matchmaker_matched) {
			this.matched.push(msg.matchmaker_matched)
			for (const wake of this.waiters.splice(0)) wake()
		}
	}

	private send(envelope: object): Promise<any> {
		const cid = String(++this.cid)
		return new Promise((resolve, reject) => {
			this.pending.set(cid, { resolve, reject })
			this.ws.send(JSON.stringify({ cid, ...envelope }))
		})
	}

	// A ticket, as the mod's NL.queue sends it.
	async queue(t: Ticket): Promise<void> {
		const reply = await this.send({
			matchmaker_add: {
				min_count: 2,
				max_count: 2,
				query: t.query,
				string_properties: t.stringProperties,
				numeric_properties: t.numericProperties,
			},
		})
		this.ticket = reply.matchmaker_ticket.ticket
	}

	async unqueue(): Promise<void> {
		if (!this.ticket) return
		const ticket = this.ticket
		this.ticket = null
		await this.send({ matchmaker_remove: { ticket } }).catch(() => undefined)
	}

	// The mod's NL.requeue: the old ticket withdrawn, a fresh one added.
	async requeue(t: Ticket): Promise<void> {
		await this.unqueue()
		await this.queue(t)
	}

	// The user ids of everyone in the match this client was put in, or null if
	// it has none within `ms`.
	async waitMatched(ms: number): Promise<string[] | null> {
		if (this.matched.length === 0)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms)
				this.waiters.push(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		const m = this.matched[0]
		return m ? m.users.map((u: any) => u.presence.user_id).sort() : null
	}

	close(): void {
		try {
			this.ws?.close()
		} catch {
			// Already closed.
		}
	}
}

// A run's names, so a second run never meets the first one's accounts.
const RUN = Date.now().toString(36)
export const testName = (label: string): string => `IQ${RUN}${label}`

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
