'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

/** Share / Unshare, and Copy link while shared. `link` gives the URL to copy. */
export function ShareButtons({
  link,
  shared,
  busy,
  onToggle,
}: {
  link: () => string
  shared: boolean
  busy: boolean
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(link())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className='ml-auto flex items-center gap-2'>
      {shared && (
        <Button size='sm' variant='outline' onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      )}
      <Button
        size='sm'
        variant={shared ? 'outline' : 'default'}
        disabled={busy}
        onClick={onToggle}
      >
        {shared ? 'Unshare' : 'Share'}
      </Button>
    </div>
  )
}
