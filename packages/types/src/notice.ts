// The Notice (apps/web/src/app/notice/page.tsx) that players accept before
// they play online. The website shows NOTICE_DATE; Nakama and the API gate
// logins on NOTICE_VERSION. Raise NOTICE_VERSION in the same commit as any
// change to the Notice text: every player then accepts again.
export const NOTICE_VERSION = 1
// The "Last updated" date the Notice shows (ISO yyyy-mm-dd).
export const NOTICE_DATE = '2026-06-13'
