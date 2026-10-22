'use client'

import { Badge } from '@/components/ui/badge'
import { formatTime } from '../../lib/format'
import type {
  ChatVerdict,
  FlaggedChatEvidence as Evidence,
} from '../../lib/types'
import { ChatTail, Empty, Facts, Section } from './shared'

const verdictText = (verdict: ChatVerdict) =>
  verdict.source === 'local' ? 'Word list' : `Classifier band: ${verdict.band}`

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The message split into plain and matched-term pieces; `at` is where each
// piece starts.
export function highlightTerms(
  message: string,
  terms: readonly string[]
): { text: string; matched: boolean; at: number }[] {
  const wanted = terms.filter((t) => t.trim())
  if (!wanted.length) return [{ text: message, matched: false, at: 0 }]
  const pattern = new RegExp(`(${wanted.map(escapeRegExp).join('|')})`, 'gi')
  let at = 0
  return message
    .split(pattern)
    .filter((piece) => piece !== '')
    .map((piece) => {
      const start = at
      at += piece.length
      return {
        text: piece,
        matched: wanted.some((t) => t.toLowerCase() === piece.toLowerCase()),
        at: start,
      }
    })
}

export function FlaggedChatEvidence({ evidence }: { evidence: Evidence }) {
  const terms =
    evidence.verdict.source === 'local' ? evidence.verdict.matches : []
  return (
    <div className='space-y-3'>
      <Section title='Flagged message'>
        <p className='rounded bg-destructive/10 px-3 py-2 font-mono text-sm'>
          {highlightTerms(evidence.message.message, terms).map((piece) =>
            piece.matched ? (
              <mark
                key={piece.at}
                className='rounded bg-destructive px-0.5 text-white'
              >
                {piece.text}
              </mark>
            ) : (
              <span key={piece.at}>{piece.text}</span>
            )
          )}
        </p>
        <Facts
          rows={[
            ['Verdict', verdictText(evidence.verdict)],
            ['Lobby', evidence.source?.lobbyCode ?? '—'],
            [
              'Sent',
              formatTime(evidence.source?.sentAt ?? evidence.message.flaggedAt),
            ],
            [
              'Already muted',
              evidence.alreadyMuted ? (
                <Badge key='m' variant='destructive'>
                  yes
                </Badge>
              ) : (
                'no'
              ),
            ],
          ]}
        />
      </Section>

      <Section title='Surrounding chat'>
        <ChatTail lines={evidence.context} />
      </Section>

      <Section title='Other flagged messages (30 days)'>
        {evidence.otherFlags.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className='space-y-1 text-sm'>
            {evidence.otherFlags.map((f) => (
              <li key={f.id}>
                <span className='text-muted-foreground'>
                  {formatTime(f.flaggedAt)}
                </span>{' '}
                <span className='font-mono'>{f.message}</span>{' '}
                <Badge variant='outline'>{verdictText(f.verdict)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
