import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiFetch } from '@/lib/api'
import type {
  ModProfile,
  ModProfileVersionMode,
  ModSummary,
  ModVersion,
} from './ranked-mods-types'

const VERSION_MODE_LABELS: Record<ModProfileVersionMode, string> = {
  exact: 'Exact version',
  latest: 'Latest',
  latestRanked: 'Ranked pin',
}

export function ProfileEntriesDialog({
  profile,
  mods,
  isAdmin,
  isPending,
  onSetEntry,
  onRemoveEntry,
  onClose,
}: {
  profile: ModProfile | null
  mods: ModSummary[]
  isAdmin: boolean
  isPending: boolean
  onSetEntry: (
    modId: string,
    versionMode: ModProfileVersionMode,
    pinnedVersion: string | null,
    allowed: boolean
  ) => void
  onRemoveEntry: (modId: string) => void
  onClose: () => void
}) {
  const [modId, setModId] = useState('')
  const [versionMode, setVersionMode] =
    useState<ModProfileVersionMode>('latest')
  const [pinnedVersion, setPinnedVersion] = useState('')
  const [allowed, setAllowed] = useState(true)

  const { data: versions, isLoading: versionsLoading } = useQuery<
    ModVersion[]
  >({
    queryKey: ['mod-versions', modId],
    queryFn: () =>
      apiFetch(`/webadmin/mods/${encodeURIComponent(modId)}/versions`),
    enabled: modId !== '' && versionMode === 'exact',
  })

  const modTitle = (id: string) => mods.find((m) => m.id === id)?.title
  const sortedMods = [...mods].sort((a, b) => a.title.localeCompare(b.title))

  const resetForm = () => {
    setModId('')
    setVersionMode('latest')
    setPinnedVersion('')
    setAllowed(true)
  }

  const editEntry = (entry: ModProfile['entries'][number]) => {
    setModId(entry.modId)
    setVersionMode(entry.versionMode)
    setPinnedVersion(entry.pinnedVersion ?? '')
    setAllowed(entry.allowed)
  }

  const isEditingExisting =
    profile?.entries.some((e) => e.modId === modId) ?? false

  return (
    <Dialog
      open={profile !== null}
      onOpenChange={(o) => {
        if (!o) {
          resetForm()
          onClose()
        }
      }}
    >
      <DialogContent className='sm:max-w-[700px]'>
        <DialogHeader>
          <DialogTitle>{profile?.name}: mods</DialogTitle>
          <DialogDescription>
            Each mod is pinned to an exact version, the newest version, or the
            mod's ranked pin. A mod that is not allowed is listed as blocked.
          </DialogDescription>
        </DialogHeader>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mod</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Allowed</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile?.entries.map((entry) => {
              const title = modTitle(entry.modId)
              return (
                <TableRow key={entry.modId}>
                  <TableCell>
                    {title ?? (
                      <span className='text-destructive'>
                        {entry.modId} (not in catalog)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {entry.versionMode === 'exact'
                      ? entry.pinnedVersion
                      : VERSION_MODE_LABELS[entry.versionMode]}
                  </TableCell>
                  <TableCell>{entry.allowed ? 'Yes' : 'No'}</TableCell>
                  <TableCell className='space-x-1 text-right'>
                    {isAdmin && (
                      <>
                        {title && (
                          <Button
                            variant='ghost'
                            size='sm'
                            disabled={isPending}
                            onClick={() => editEntry(entry)}
                          >
                            Edit
                          </Button>
                        )}
                        <Button
                          variant='ghost'
                          size='sm'
                          disabled={isPending}
                          onClick={() => onRemoveEntry(entry.modId)}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {(profile?.entries.length ?? 0) === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className='text-center text-muted-foreground'
                >
                  No mods in this profile yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {isAdmin && (
          <div className='flex flex-wrap items-end gap-3 border-border border-t pt-4'>
            <div className='min-w-48 flex-1'>
              <Select
                value={modId}
                onValueChange={(v) => {
                  setModId(v)
                  setPinnedVersion('')
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder='Mod' />
                </SelectTrigger>
                <SelectContent>
                  {sortedMods.map((mod) => (
                    <SelectItem key={mod.id} value={mod.id}>
                      {mod.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Select
              value={versionMode}
              onValueChange={(v) => setVersionMode(v as ModProfileVersionMode)}
            >
              <SelectTrigger className='w-36'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(VERSION_MODE_LABELS) as ModProfileVersionMode[]
                ).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {VERSION_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {versionMode === 'exact' && (
              <Select
                value={pinnedVersion}
                onValueChange={setPinnedVersion}
                disabled={!modId}
              >
                <SelectTrigger className='w-44 font-mono text-xs'>
                  <SelectValue
                    placeholder={versionsLoading ? 'Loading…' : 'Version'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {pinnedVersion &&
                    !versions?.some((v) => v.version === pinnedVersion) && (
                      <SelectItem value={pinnedVersion}>
                        {pinnedVersion}
                      </SelectItem>
                    )}
                  {versions?.map((v) => (
                    <SelectItem key={v.version} value={v.version}>
                      {v.version}
                      <span className='ml-2 text-muted-foreground'>
                        {v.source}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className='flex items-center gap-2 pb-2'>
              <Switch
                id='entry-allowed'
                checked={allowed}
                onCheckedChange={setAllowed}
              />
              <Label htmlFor='entry-allowed'>Allowed</Label>
            </div>
            <Button
              disabled={
                !modId ||
                isPending ||
                (versionMode === 'exact' && !pinnedVersion)
              }
              onClick={() => {
                onSetEntry(
                  modId,
                  versionMode,
                  versionMode === 'exact' ? pinnedVersion : null,
                  allowed
                )
                resetForm()
              }}
            >
              {isEditingExisting ? 'Save' : 'Add'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
