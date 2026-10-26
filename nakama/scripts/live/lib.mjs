// Zero-dependency live harness for a local Dev server (compose.local.yml, dev profile):
// throwaway device-auth players over Nakama's REST API and realtime socket
// (Node's built-in fetch and WebSocket), admin RPCs with the local http key,
// Express HTTP routes, and psql through `docker exec bmp-postgres`.
//
// Dev server only: it relies on Device login and the public placeholder keys
// from nakama/local.yml / compose.local.yml. Every
// account it makes is prefixed (PREFIX) so it can be found and cleaned up.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'

export const NAKAMA = process.env.BMP_NAKAMA_URL || 'http://127.0.0.1:7350'
export const EXPRESS = process.env.BMP_EXPRESS_URL || 'http://127.0.0.1:8788'
export const SERVER_KEY = process.env.BMP_SERVER_KEY || 'defaultkey'
export const HTTP_KEY = process.env.BMP_HTTP_KEY || 'local-dev-http-key'
export const PREFIX = process.env.BMP_TEST_PREFIX || 'h1test_'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const results = []
export function check(name, ok, detail = '') {
	results.push({ name, ok: !!ok, detail })
	const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`
	console.log(line)
	return !!ok
}
export function summary(label) {
	const passed = results.filter((r) => r.ok).length
	const failed = results.length - passed
	console.log(`${label}: ${passed} passed, ${failed} failed`)
	return failed
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function retrying(fn, attempts = 15) {
	let last
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (e) {
			// Nakama may be restarted by another agent: wait it out.
			last = e
			await sleep(2000)
		}
	}
	throw last
}

async function http(method, url, { headers = {}, body } = {}) {
	return retrying(async () => {
		const res = await fetch(url, {
			method,
			headers: { 'content-type': 'application/json', ...headers },
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		})
		const text = await res.text()
		let json = null
		try {
			json = text ? JSON.parse(text) : null
		} catch (e) {
			// Not JSON.
		}
		return { status: res.status, json, text }
	})
}

// A device-auth player. username is prefixed; the device id is derived from it
// so a rerun logs back into the same account.
export async function deviceAuth(name, { create = true } = {}) {
	const username = name.startsWith(PREFIX) ? name : PREFIX + name
	const deviceId = `${username}_device`.padEnd(12, '0')
	const basic = Buffer.from(`${SERVER_KEY}:`).toString('base64')
	const res = await http(
		'POST',
		`${NAKAMA}/v2/account/authenticate/device?create=${create}&username=${encodeURIComponent(username)}`,
		{ headers: { authorization: `Basic ${basic}` }, body: { id: deviceId } },
	)
	if (res.status !== 200) return { error: res, username, deviceId }
	const token = res.json.token
	const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
	return { token, refreshToken: res.json.refresh_token, userId: claims.uid, username, deviceId }
}

// A player RPC with the player's session. Returns {status, body, error}.
export async function rpc(token, id, payload = {}) {
	const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
	const res = await http('POST', `${NAKAMA}/v2/rpc/${id}?unwrap`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body,
	})
	return { status: res.status, body: res.json, text: res.text, ok: res.status === 200 }
}

// A client's session start: session_init, then its mod report, as MPAPI does
// on every CONNECTED. Matchmaking always needs a report of allowed mods
// (standing/), so a test player that queues reports the platform baseline
// only -- allowed whatever is pinned.
export const BASELINE_REPORT = ['Steamodded-1.0.0~BETA-1814a', 'Lovely-0.9.0']
export async function startSession(p, mods = BASELINE_REPORT) {
	const init = await rpc(p.token, 'session_init', { steamName: p.username })
	await rpc(p.token, 'profile_set_mods', { mods })
	return init
}

// A server-only admin RPC with the http key (or another key, for refusal tests).
export async function admin(id, payload = {}, key = HTTP_KEY) {
	const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
	const q = key === null ? 'unwrap' : `http_key=${encodeURIComponent(key)}&unwrap`
	const res = await http('POST', `${NAKAMA}/v2/rpc/${id}?${q}`, { body })
	return { status: res.status, body: res.json, text: res.text, ok: res.status === 200 }
}

export async function express(method, path, { token, body, headers = {} } = {}) {
	const r = await http(method, `${EXPRESS}${path}`, {
		headers: token ? { authorization: `Bearer ${token}`, ...headers } : headers,
		body,
	})
	return { ...r, body: r.json, ok: r.status >= 200 && r.status < 300 }
}

export async function nakamaRest(method, path, token, body) {
	return http(method, `${NAKAMA}${path}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body,
	})
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

// Rows of a query as arrays of strings (psql -At, '|' separated).
export function psql(db, query) {
	const out = execFileSync('docker', ['exec', 'bmp-postgres', 'psql', '-U', 'postgres', '-d', db, '-At', '-F', '|', '-c', query], {
		encoding: 'utf8',
	})
	return out
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => l.split('|'))
}
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`

// ---------------------------------------------------------------------------
// Express web sessions (webadmin)
// ---------------------------------------------------------------------------

// The JWT Express's authenticate middleware accepts, signed with the local
// api-green's JWT_SECRET (read from the container). HS256 by hand: no deps.
let jwtSecret = null
// `extra` adds claims, e.g. { purpose: 'tos-accept' } for the ToS-pending token.
export function webJwt(playerId, steamName, extra = {}) {
	if (!jwtSecret) {
		const env = execFileSync('docker', ['inspect', 'bmp-api-green', '--format', '{{range .Config.Env}}{{println .}}{{end}}'], {
			encoding: 'utf8',
		})
		const line = env.split('\n').find((l) => l.startsWith('JWT_SECRET='))
		if (!line) throw new Error('JWT_SECRET not found in bmp-api-green env')
		jwtSecret = line.slice('JWT_SECRET='.length)
	}
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
	const now = Math.floor(Date.now() / 1000)
	const head = b64({ alg: 'HS256', typ: 'JWT' })
	const body = b64({ playerId, steamName, iat: now, exp: now + 3600, ...extra })
	const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
	return `${head}.${body}.${sig}`
}

// ---------------------------------------------------------------------------
// Realtime socket
// ---------------------------------------------------------------------------

export const ClientOp = { LEAVE: 1, KICK: 2, SET_METADATA: 3, SET_STATE: 4, ACTION: 5 }
export const ServerOp = {
	SNAPSHOT: 100,
	EVENT: 101,
	METADATA: 102,
	PLAYER_INFO: 103,
	ERROR: 104,
	ACTION: 105,
	ACTION_REJECTED: 106,
	CHAT: 107,
	GROUP_QUEUE: 112,
}

export class Socket {
	constructor(player) {
		this.player = player
		this.cid = 0
		this.pending = new Map()
		// Everything received that isn't a cid reply: {kind, ...}.
		this.inbox = []
		this.waiters = []
		this.closed = false
	}

	async open() {
		const url = `${NAKAMA.replace(/^http/, 'ws')}/ws?lang=en&status=true&token=${encodeURIComponent(this.player.token)}`
		this.ws = new WebSocket(url)
		await new Promise((resolve, reject) => {
			this.ws.onopen = resolve
			this.ws.onerror = (e) => reject(new Error('socket error ' + (e.message || '')))
		})
		this.ws.onclose = (e) => {
			this.closed = true
			this.closeCode = e.code
			this.push({ kind: 'closed', code: e.code })
		}
		this.ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)))
		return this
	}

	push(item) {
		this.inbox.push(item)
		for (const w of this.waiters.slice()) {
			if (w.pred(item)) {
				this.waiters.splice(this.waiters.indexOf(w), 1)
				w.resolve(item)
			}
		}
	}

	onMessage(msg) {
		if (msg.cid && this.pending.has(msg.cid)) {
			const p = this.pending.get(msg.cid)
			this.pending.delete(msg.cid)
			p(msg)
			return
		}
		if (msg.match_data) {
			const d = msg.match_data
			let data = null
			try {
				data = JSON.parse(Buffer.from(d.data || '', 'base64').toString())
			} catch (e) {
				data = Buffer.from(d.data || '', 'base64').toString()
			}
			this.push({ kind: 'data', op: Number(d.op_code), data, matchId: d.match_id })
		} else if (msg.notifications) {
			for (const n of msg.notifications.notifications || []) {
				let content = n.content
				try {
					content = JSON.parse(n.content)
				} catch (e) {
					// keep raw
				}
				this.push({ kind: 'notification', code: Number(n.code), subject: n.subject, content })
			}
		} else if (msg.matchmaker_matched) {
			this.push({ kind: 'matched', ...msg.matchmaker_matched })
		} else if (msg.error) {
			this.push({ kind: 'error', error: msg.error })
		} else {
			this.push({ kind: 'other', msg })
		}
	}

	// One request envelope, answered by cid.
	request(envelope, timeoutMs = 10000) {
		const cid = String(++this.cid)
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(cid)
				resolve({ timeout: true })
			}, timeoutMs)
			this.pending.set(cid, (m) => {
				clearTimeout(timer)
				resolve(m)
			})
			this.ws.send(JSON.stringify({ cid, ...envelope }))
		})
	}

	// Waits for an inbox item matching pred (already received ones count unless
	// `since` excludes them). Resolves null on timeout.
	waitFor(pred, timeoutMs = 10000, since = 0) {
		for (let i = since; i < this.inbox.length; i++) if (pred(this.inbox[i])) return Promise.resolve(this.inbox[i])
		return new Promise((resolve) => {
			const w = { pred, resolve }
			this.waiters.push(w)
			setTimeout(() => {
				const i = this.waiters.indexOf(w)
				if (i !== -1) {
					this.waiters.splice(i, 1)
					resolve(null)
				}
			}, timeoutMs)
		})
	}

	mark() {
		return this.inbox.length
	}

	async join(matchId, metadata = {}) {
		this.matchId = matchId
		return this.request({ match_join: { match_id: matchId, metadata } })
	}

	// Fire-and-forget match data (no reply from Nakama).
	sendOp(op, data, matchId = this.matchId) {
		const raw = typeof data === 'string' ? data : JSON.stringify(data)
		this.ws.send(
			JSON.stringify({
				match_data_send: { match_id: matchId, op_code: String(op), data: Buffer.from(raw).toString('base64') },
			}),
		)
	}

	// An ACTION; `to` 'server' for an authoritative one. Returns the cid.
	action(action, params, to = 'server') {
		const cid = randomUUID().slice(0, 12)
		this.sendOp(ClientOp.ACTION, { cid, action, to, params })
		return cid
	}

	// Sends an authoritative action and waits for its result or rejection.
	async ask(action, params, timeoutMs = 8000) {
		const since = this.mark()
		const cid = this.action(action, params, 'server')
		const reply = await this.waitFor(
			(i) =>
				i.kind === 'data' &&
				(i.op === ServerOp.ACTION || i.op === ServerOp.ACTION_REJECTED) &&
				i.data &&
				i.data.cid === cid,
			timeoutMs,
			since,
		)
		if (!reply) return { timeout: true }
		return reply.op === ServerOp.ACTION_REJECTED ? { rejected: reply.data.reason } : { ok: true, params: reply.data.params }
	}

	close() {
		try {
			this.ws.close()
		} catch (e) {
			// already closed
		}
	}
}

export async function connect(player) {
	return new Socket(player).open()
}

// A lobby with `players` seated (first one hosts). Returns {code, matchId, sockets}.
export async function lobbyWith(players, { modId = PREFIX + 'mod', maxPlayers, rankedMode } = {}) {
	const host = players[0]
	const created = await rpc(host.token, 'lobby_create', { modId, maxPlayers, rankedMode })
	if (!created.ok) throw new Error('lobby_create failed: ' + created.text)
	const { matchId, code } = created.body
	const sockets = []
	for (const p of players) {
		const s = p.socket || (await connect(p))
		p.socket = s
		const joined = await s.join(matchId, { modId, displayName: p.username })
		if (joined.error) throw new Error(`${p.username} join failed: ${JSON.stringify(joined.error)}`)
		await s.waitFor((i) => i.kind === 'data' && i.op === ServerOp.SNAPSHOT, 5000)
		sockets.push(s)
	}
	return { code, matchId, modId, sockets }
}

// Readies every non-host, starts as host. Returns the started params.
export async function startGame(players, params = {}) {
	for (const p of players.slice(1)) {
		const r = await p.socket.ask('mpapi_ready', { ready: true })
		if (!r.ok) throw new Error('ready failed: ' + JSON.stringify(r))
	}
	const r = await players[0].socket.ask('mpapi_start_game', params)
	if (!r.ok) throw new Error('start failed: ' + JSON.stringify(r))
	return r.params
}

export function sha256Hex(s) {
	return createHash('sha256').update(s).digest('hex')
}

// Sends a small replay log the way MPAPI's recorder does, ending in a 'chk'
// event whose carbon is the SHA-256 the server recomputes (log_check.ts).
// `tamper` makes the claimed hash wrong.
export async function sendLog(socket, runId, events, { tamper = false } = {}) {
	const lines = []
	for (const [t, opcode, args] of events) {
		socket.action('mpapi_log_event', { t, opcode, args, run: runId })
		// 'end' and 'chk' are framing: not part of the hashed log.
		if (opcode !== 'end') lines.push(JSON.stringify([t, opcode, args === undefined ? null : args]))
	}
	let carbon = sha256Hex(`[${lines.join(',')}]`)
	if (tamper) carbon = sha256Hex('tampered' + carbon)
	socket.action('mpapi_log_event', { t: 99999, opcode: 'chk', args: { carbon }, run: runId })
	return carbon
}

// Polls until fn returns truthy (or the timeout passes); returns the last value.
export async function poll(fn, timeoutMs = 20000, everyMs = 1000) {
	const until = Date.now() + timeoutMs
	let v
	for (;;) {
		v = await fn()
		if (v || Date.now() > until) return v
		await sleep(everyMs)
	}
}

export function nakamaLogsSince(since) {
	// Nakama logs to stderr; keep both streams.
	const r = spawnSync('docker', ['logs', '--since', since, 'bmp-nakama'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
	return (r.stdout || '') + (r.stderr || '')
}

// The server config as stored (read-only: never goes through admin_config_set,
// which writes even when given {}).
export function serverConfig() {
	const rows = psql('nakama', "select value from storage where collection='server_config' and key='global'")
	return rows.length ? JSON.parse(rows[0][0]) : {}
}
