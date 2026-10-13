import { describe, expect, it } from 'vitest'
import { CURRENT_LOBBY_COLLECTION, CURRENT_LOBBY_KEY } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { REPORT_LIMIT, REPORT_WINDOW_MS, parseReport, reportTimesAfter, rpcReportSubmit } from './report'

const ME = '11111111-1111-4111-8111-111111111111'
const THEM = '22222222-2222-4222-8222-222222222222'
const MATCH = '33333333-3333-4333-8333-333333333333.nakama'
const ENV = { EXPRESS_INTERNAL_URL: 'http://api', EXPRESS_INTERNAL_KEY: 'k' }
const EVIDENCE = {
	code: 'ABC123',
	runId: null,
	chat: [{ playerId: THEM, displayName: 'Them', message: 'rude', sentAt: 5 }],
}

function seated(httpCode = 200, evidence: unknown = EVIDENCE) {
	const nk = fakeNk({
		matchGet: () => ({ matchId: MATCH }),
		matchSignal: (_id: string, data: string) => {
			const signal = JSON.parse(data)
			if (signal.type === 'has_player') return 'yes'
			if (signal.type === 'report_evidence') return JSON.stringify(evidence)
			return ''
		},
		httpRequest: (url: string, _m: string, _h: unknown, body: string) => {
			nk.http.push({ url, method: 'post', headers: {}, body })
			return { code: httpCode, headers: {}, body: httpCode === 200 ? '{"ok":true,"reportId":42}' : '{}' }
		},
	})
	nk.storageWrite([
		{ collection: CURRENT_LOBBY_COLLECTION, key: CURRENT_LOBBY_KEY, userId: ME, value: { matchId: MATCH, code: 'ABC123', modId: 'm' } },
	])
	return nk
}

const submit = (nk: any, body: unknown) => rpcReportSubmit(playerCtx(ME, ENV), fakeLogger, nk, JSON.stringify(body))

describe('parseReport', () => {
	it('accepts the API report types and an optional message', () => {
		expect(parseReport({ reportedUserId: THEM, type: 'griefing' })).toEqual({ reportedUserId: THEM, type: 'griefing', message: undefined })
		expect(parseReport({ reportedUserId: THEM, type: 'other', message: 'x' })).toMatchObject({ message: 'x' })
	})
	it('refuses bad input', () => {
		expect(parseReport({ type: 'other' })).toBe('Missing or invalid reportedUserId')
		expect(parseReport({ reportedUserId: THEM, type: 'spam' })).toBe('Invalid report type')
		expect(parseReport({ reportedUserId: THEM, type: 'other', message: 'x'.repeat(501) })).toMatch(/max 500/)
	})
})

describe('reportTimesAfter', () => {
	it('allows REPORT_LIMIT reports per window', () => {
		let times: number[] = []
		for (let i = 0; i < REPORT_LIMIT; i++) times = reportTimesAfter(times, i) as number[]
		expect(reportTimesAfter(times, REPORT_LIMIT)).toBeNull()
		expect(reportTimesAfter(times, REPORT_WINDOW_MS)).toHaveLength(REPORT_LIMIT)
	})
})

describe('report_submit', () => {
	it('hands the report and its evidence to the API', () => {
		const nk = seated()
		expect(JSON.parse(submit(nk, { reportedUserId: THEM, type: 'chat_abuse', message: 'mean' }))).toEqual({ ok: true, reportId: 42 })
		expect(nk.http).toHaveLength(1)
		expect(nk.http[0].url).toBe('http://api/internal/nakama/reports')
		expect(JSON.parse(nk.http[0].body)).toEqual({
			reporterId: ME,
			reportedId: THEM,
			type: 'chat_abuse',
			message: 'mean',
			lobbyId: '33333333-3333-4333-8333-333333333333',
			lobbyCode: 'ABC123',
			runId: null,
			chat: EVIDENCE.chat,
		})
	})
	it('refuses a reporter who is not in a lobby', () => {
		const nk = seated()
		nk.storageDelete([{ collection: CURRENT_LOBBY_COLLECTION, key: CURRENT_LOBBY_KEY, userId: ME }])
		expect(() => submit(nk, { reportedUserId: THEM, type: 'other' })).toThrow(expect.objectContaining({ message: 'Not in a lobby' }))
	})
	it('passes on the lobby refusing the report', () => {
		const nk = seated(200, { error: 'unknown_player' })
		expect(() => submit(nk, { reportedUserId: THEM, type: 'other' })).toThrow(
			expect.objectContaining({ message: 'That player is not in this lobby' }),
		)
		expect(nk.http).toHaveLength(0)
	})
	it('fails when the API does not take it, without using up the limit', () => {
		const nk = seated(500)
		for (let i = 0; i < REPORT_LIMIT + 1; i++)
			expect(() => submit(nk, { reportedUserId: THEM, type: 'other' })).toThrow(expect.objectContaining({ code: 14 }))
	})
	it('rate limits the reporter', () => {
		const nk = seated()
		for (let i = 0; i < REPORT_LIMIT; i++) submit(nk, { reportedUserId: THEM, type: 'other' })
		expect(() => submit(nk, { reportedUserId: THEM, type: 'other' })).toThrow(expect.objectContaining({ code: 8 }))
	})
})
