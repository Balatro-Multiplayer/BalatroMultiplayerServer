'use client'

import { DownloadIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { API_BASE, apiFetch } from '@/lib/api'

type OS = 'Windows' | 'Mac' | 'Linux' | 'Unknown'

interface LatestLauncherResponse {
  version: string
  releasedAt: string
  platforms: Record<'windows' | 'mac' | 'linux', { downloadUrl: string } | null>
}

const OS_TO_PLATFORM: Record<
  Exclude<OS, 'Unknown'>,
  'windows' | 'mac' | 'linux'
> = {
  Windows: 'windows',
  Mac: 'mac',
  Linux: 'linux',
}

type Links = Partial<Record<Exclude<OS, 'Unknown'>, string>>

async function loadLauncherLinks(): Promise<Links> {
  const res = await apiFetch<LatestLauncherResponse>('/launcher/latest')
  const links: Links = {}
  for (const os of Object.keys(OS_TO_PLATFORM) as Array<
    Exclude<OS, 'Unknown'>
  >) {
    const platform = res.platforms[OS_TO_PLATFORM[os]]
    // downloadUrl is already a full "/api/launcher/download/..." path
    // meant for direct navigation (nginx routes /api/ straight to the
    // API server) -- unlike apiFetch's JSON calls, this isn't routed
    // through the /api/proxy Next.js handler, so it must NOT be prefixed
    // with API_BASE (doing so double-prefixes /api, since the proxy
    // handler itself re-adds /api to whatever path it receives).
    if (platform) links[os] = platform.downloadUrl
  }
  return links
}

// BMP r2modman's installers come from the electron-updater feed at
// /api/r2modman/updates (see r2modman-releases.route.ts). Each OS's
// latest*.yml lists the release's files; we pick the installer a player
// should run by its extension. Downloads go straight to /api/, as above.
const R2MODMAN_FEEDS: Record<Exclude<OS, 'Unknown'>, [string, string]> = {
  Windows: ['latest.yml', '.exe'],
  Mac: ['latest-mac.yml', '.dmg'],
  Linux: ['latest-linux.yml', '.AppImage'],
}

async function loadR2modmanLinks(): Promise<Links> {
  const links: Links = {}
  await Promise.all(
    (Object.keys(R2MODMAN_FEEDS) as Array<Exclude<OS, 'Unknown'>>).map(
      async (os) => {
        const [feed, ext] = R2MODMAN_FEEDS[os]
        const res = await fetch(`${API_BASE}/r2modman/updates/${feed}`)
        if (!res.ok) return
        const files = [...(await res.text()).matchAll(/url: *(.+)/g)].map((m) =>
          (m[1] ?? '').trim()
        )
        const file = files.find((f) => f.endsWith(ext))
        if (file) {
          links[os] = `/api/r2modman/updates/${encodeURIComponent(file)}`
        }
      }
    )
  )
  return links
}

const LOADERS = {
  launcher: loadLauncherLinks,
  r2modman: loadR2modmanLinks,
}

export function OSDownloadButton({
  product,
}: {
  product: keyof typeof LOADERS
}) {
  const [detectedOS, setDetectedOS] = useState<OS>('Unknown')
  const [selectedOS, setSelectedOS] = useState<OS>('Unknown')
  const [showOptions, setShowOptions] = useState(false)
  const [downloadLinks, setDownloadLinks] = useState<Links>({})

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase()

    if (userAgent.indexOf('win') !== -1) {
      setDetectedOS('Windows')
      setSelectedOS('Windows')
    } else if (userAgent.indexOf('mac') !== -1) {
      setDetectedOS('Mac')
      setSelectedOS('Mac')
    } else if (
      userAgent.indexOf('linux') !== -1 ||
      userAgent.indexOf('x11') !== -1
    ) {
      setDetectedOS('Linux')
      setSelectedOS('Linux')
    }
  }, [])

  useEffect(() => {
    LOADERS[product]()
      .then(setDownloadLinks)
      .catch(() => {
        // No release uploaded yet (or the request failed) -- every button
        // just stays disabled below rather than erroring the page.
      })
  }, [product])

  const downloadLink = downloadLinks[selectedOS as Exclude<OS, 'Unknown'>] ?? ''
  const downloadText = downloadLink
    ? `Download for ${selectedOS}`
    : `${selectedOS} build not available yet`

  return (
    <div className='flex flex-col items-center gap-2'>
      {detectedOS !== 'Unknown' && (
        <>
          <Button
            asChild={!!downloadLink}
            disabled={!downloadLink}
            className='no-underline'
          >
            {downloadLink ? (
              <a href={downloadLink} rel='noopener noreferrer'>
                <DownloadIcon className='mr-2' />
                {downloadText}
              </a>
            ) : (
              <span>{downloadText}</span>
            )}
          </Button>

          <div className='mt-1 text-sm'>
            <button
              type='button'
              onClick={() => setShowOptions(!showOptions)}
              className='text-blue-500 hover:underline'
            >
              {showOptions ? 'Hide other options' : `Not using ${detectedOS}?`}
            </button>
          </div>

          {showOptions && (
            <div className='mt-2 flex gap-2'>
              {(
                Object.keys(OS_TO_PLATFORM) as Array<Exclude<OS, 'Unknown'>>
              ).map(
                (os) =>
                  os !== selectedOS && (
                    <Button
                      key={os}
                      variant='outline'
                      size='sm'
                      onClick={() => setSelectedOS(os)}
                      className='no-underline'
                    >
                      {os}
                    </Button>
                  )
              )}
            </div>
          )}
        </>
      )}

      {detectedOS === 'Unknown' && (
        <div className='flex flex-col gap-2'>
          <p className='text-center'>Select your operating system:</p>
          <div className='flex justify-center gap-2'>
            {(Object.keys(OS_TO_PLATFORM) as Array<Exclude<OS, 'Unknown'>>).map(
              (os) => (
                <Button
                  key={os}
                  variant={selectedOS === os ? 'default' : 'outline'}
                  onClick={() => setSelectedOS(os)}
                  className='no-underline'
                >
                  {os}
                </Button>
              )
            )}
          </div>

          {selectedOS !== 'Unknown' && (
            <Button
              asChild={!!downloadLink}
              disabled={!downloadLink}
              className='mt-2 no-underline'
            >
              {downloadLink ? (
                <a href={downloadLink} rel='noopener noreferrer'>
                  <DownloadIcon className='mr-2' />
                  {downloadText}
                </a>
              ) : (
                <span>{downloadText}</span>
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
