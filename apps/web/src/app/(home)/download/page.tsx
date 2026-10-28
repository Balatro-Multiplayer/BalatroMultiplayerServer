import { ExternalLinkIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createMetadata } from '@/lib/metadata'
import { OSDownloadButton } from '../../_components/os-download-button'

export const metadata = createMetadata({
  title: 'Download',
  description: 'Install the Balatro Multiplayer mods.',
  path: '/download',
})

const R2MODMAN_URL = 'https://thunderstore.io/c/balatro/p/ebkr/r2modman/'
const GITHUB = 'https://github.com/Balatro-Multiplayer'

// Spreads the rest so Button asChild can pass its class and handlers through.
function ExternalLink(props: ComponentProps<'a'>) {
  return (
    <a
      className='underline'
      target='_blank'
      rel='noopener noreferrer'
      {...props}
    />
  )
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className='break-all rounded bg-muted px-1 py-0.5 text-xs'>
      {children}
    </code>
  )
}

export default function DownloadPage() {
  return (
    <div className='mx-auto flex w-[calc(100%-1rem)] max-w-fd-container flex-1 flex-col py-8'>
      <div className='mb-10 text-center'>
        <h1 className='font-bold text-4xl tracking-tight'>Download</h1>
        <p className='mt-4 text-lg text-muted-foreground'>
          Get set up with Balatro Multiplayer
        </p>
      </div>

      <div className='space-y-8'>
        <Card>
          <CardHeader>
            <CardTitle>Recommended: Install with r2modman</CardTitle>
            <CardDescription>
              r2modman is the Thunderstore mod manager. It installs the
              Multiplayer mods and everything they need, and keeps them up to
              date.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-6'>
            <div className='flex flex-col items-center gap-4'>
              <Button asChild className='no-underline'>
                <ExternalLink href={R2MODMAN_URL}>
                  <ExternalLinkIcon className='mr-2' />
                  Get r2modman
                </ExternalLink>
              </Button>
            </div>
            <div className='rounded-lg border bg-card p-4'>
              <ol className='list-inside list-decimal space-y-1 text-muted-foreground text-sm'>
                <li>Install r2modman, open it and select Balatro.</li>
                <li>Create a profile, or use the default one.</li>
                <li>
                  In <strong>Online</strong>, search for{' '}
                  <strong>MultiplayerPvP</strong> and{' '}
                  <strong>MultiplayerSpeedrun</strong>, and install the
                  gamemodes you want. r2modman also installs Lovely, Steamodded
                  and MultiplayerAPI for you.
                </li>
                <li>
                  Click <strong>Start modded</strong>. Keep Steam open: you log
                  in with your Steam account.
                </li>
              </ol>
              <p className='mt-2 text-muted-foreground text-sm'>
                This is all you need for Casual games and lobbies. Ranked needs
                one of the apps below.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>To play Ranked</CardTitle>
            <CardDescription>
              Ranked games need an app with our anti-cheat. Pick the one you
              like better. Both install the same mods.
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-6 md:grid-cols-2'>
            <div className='flex flex-col gap-4 rounded-lg border bg-card p-4'>
              <div>
                <h3 className='font-semibold'>BET Launcher</h3>
                <p className='mt-1 text-muted-foreground text-sm'>
                  A simple launcher made for Balatro, like Balatro Mod Manager.
                  Pick this if you do not use r2modman. It installs Lovely,
                  Steamodded and the Multiplayer mods, can install other Balatro
                  mods, and lets you switch between mod profiles in one click.
                </p>
              </div>
              <div className='mt-auto'>
                <OSDownloadButton product='launcher' />
              </div>
            </div>
            <div className='flex flex-col gap-4 rounded-lg border bg-card p-4'>
              <div>
                <h3 className='font-semibold'>BMP r2modman</h3>
                <p className='mt-1 text-muted-foreground text-sm'>
                  Our build of r2modman with the anti-cheat added. Pick this if
                  you want to keep using r2modman. It works the same as
                  r2modman, so you can use the steps above.
                </p>
              </div>
              <div className='mt-auto'>
                <OSDownloadButton product='r2modman' />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alternative: Manual installation</CardTitle>
            <CardDescription>
              Install the mods yourself, with no mod manager. You can play
              Casual games and lobbies, but not Ranked.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4 text-muted-foreground text-sm'>
            <ol className='list-inside list-decimal space-y-2'>
              <li>
                Install{' '}
                <ExternalLink href='https://github.com/ethangreen-dev/lovely-injector'>
                  Lovely
                </ExternalLink>{' '}
                0.10 or newer and{' '}
                <ExternalLink href='https://github.com/Steamodded/smods'>
                  Steamodded
                </ExternalLink>{' '}
                1.0.0~BETA-1814a or newer.
              </li>
              <li>
                Download the latest release of{' '}
                <ExternalLink
                  href={`${GITHUB}/BalatroMultiplayerAPI/releases/latest`}
                >
                  MultiplayerAPI
                </ExternalLink>{' '}
                and of the gamemodes you want:{' '}
                <ExternalLink
                  href={`${GITHUB}/BalatroMultiplayerPvP/releases/latest`}
                >
                  PvP
                </ExternalLink>{' '}
                and{' '}
                <ExternalLink
                  href={`${GITHUB}/BalatroMultiplayerSpeedrunning/releases/latest`}
                >
                  Speedrun
                </ExternalLink>
                .
              </li>
              <li>
                Extract each one into its own folder in your Balatro{' '}
                <Code>Mods</Code> folder. Make sure a mod's folder is not inside
                a second folder of the same name.
                <ul className='mt-1 ml-5 list-disc space-y-1'>
                  <li>
                    Windows: <Code>%AppData%\Balatro\Mods\</Code>
                  </li>
                  <li>
                    macOS:{' '}
                    <Code>~/Library/Application Support/Balatro/Mods/</Code>
                  </li>
                  <li>
                    Linux (Proton):{' '}
                    <Code>
                      ~/.steam/steam/steamapps/compatdata/2379780/pfx/drive_c/users/steamuser/AppData/Roaming/Balatro/Mods/
                    </Code>
                  </li>
                </ul>
              </li>
              <li>
                Start Balatro <strong>through Steam</strong>, and pick PvP or
                Speedrun from the Multiplayer menu. You log in with your Steam
                account, so the menu stays offline without Steam.
              </li>
            </ol>
            <p>
              Keep only one copy of each mod in <Code>Mods</Code>. Remove the
              old <Code>Multiplayer</Code> mod first: it conflicts with these
              mods.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
