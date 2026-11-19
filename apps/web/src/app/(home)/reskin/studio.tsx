'use client'

import { Download, RotateCcw, Upload } from 'lucide-react'
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AssetModalProvider } from './components/asset-modal'
import { AssetsTab } from './components/assets-tab'
import { ExeImport } from './components/exe-import'
import { type ImportFeedback, ImportStatus } from './components/import-status'
import { LocalizationTab } from './components/localization-tab'
import { OptionsTab } from './components/options-tab'
import catalogJson from './data/catalog.json'
import { deckSkinSpriteCount, migrateDeckSkins } from './lib/deckSkins'
import { readLocFromExe } from './lib/exeAssets'
import {
  fileFromSaved,
  forgetExe,
  pickExeHandle,
  recallExe,
  rememberBytes,
  rememberHandle,
  type SavedExe,
  supportsFsAccess,
} from './lib/exeStore'
import { GameArchive } from './lib/gameArchive'
import { findAppLove, type GameImportProgress } from './lib/gameImport'
import { importGame } from './lib/gameImportClient'
import { generatePack } from './lib/generate'
import { generateRankedBundle } from './lib/generateRanked'
import { importMalverkPack, type MalverkResult } from './lib/importMalverk'
import { importPack } from './lib/importProject'
import { importRankedBundle } from './lib/importRanked'
import { canvasRasterIO } from './lib/malverkRaster'
import { filesFromFolder, filesFromZip } from './lib/malverkSource'
import {
  type Catalog,
  emptyProject,
  type ObjectEdit,
  objId,
  type PlayingCardSkin,
  type ProjectState,
} from './lib/types'

const catalog = catalogJson as unknown as Catalog

export function ReskinStudio() {
  const [project, setProject] = useState<ProjectState>(emptyProject)
  const [busy, setBusy] = useState(false)
  const [exeBuf, setExeBuf] = useState<GameArchive | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const malverkZipRef = useRef<HTMLInputElement>(null)
  const malverkDirRef = useRef<HTMLInputElement>(null)
  const [malverk, setMalverk] = useState<{
    result: MalverkResult
    name: string
  } | null>(null)

  // Optional local game import (.exe/.love, or the .love inside a Mac app).
  // Remember a handle or archive bytes so a reload can re-import in one click.
  // The legacy exe names/IndexedDB store are retained for saved-file compatibility.
  const [canPickHandle, setCanPickHandle] = useState(false)
  const [savedExe, setSavedExe] = useState<SavedExe | null>(null)
  const [reimportOpen, setReimportOpen] = useState(false)

  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(
    null
  )
  const activeImport = useRef<AbortController | null>(null)
  useEffect(() => () => activeImport.current?.abort(), [])

  // Keep the busy state through persistence. Parsing/inflation runs in a worker,
  // so the status can paint and cancellation works even during ZIP scans.
  const applyExe = useCallback(
    async (
      source: File,
      remember = false,
      handle?: FileSystemFileHandle
    ): Promise<void> => {
      if (activeImport.current) return
      const controller = new AbortController()
      activeImport.current = controller
      setBusy(true)
      const report = (progress: GameImportProgress) =>
        setImportFeedback({
          state: 'working',
          name: source.name,
          size: source.size,
          progress,
        })
      report({ stage: 'reading' })
      try {
        const { bytes, file } = await importGame(
          source,
          report,
          controller.signal
        )
        controller.signal.throwIfAborted()
        let remembered = true
        if (remember) {
          report({ stage: 'remembering' })
          try {
            if (handle && file === source) {
              await rememberHandle(handle)
              setSavedExe({ kind: 'handle', name: handle.name, handle })
            } else {
              await rememberBytes(file)
              setSavedExe({ kind: 'bytes', name: file.name, blob: file })
            }
          } catch {
            remembered = false
            setSavedExe(null)
            await forgetExe()
          }
        }
        setExeBuf(new GameArchive(bytes))
        const message = remembered
          ? `${file.name} loaded. Vanilla art and text editing are available.`
          : `${file.name} loaded, but could not be remembered. Choose it again next time; browser storage may be disabled or full.`
        setImportFeedback({ state: 'success', message })
        if (remembered) toast.success(`${file.name} loaded`)
        else toast.warning('Game loaded, but could not be remembered')
      } catch (e) {
        if (controller.signal.aborted) {
          setImportFeedback({
            state: 'cancelled',
            message:
              'Import cancelled. Your previous game import is unchanged.',
          })
        } else {
          const message = e instanceof Error ? e.message : String(e)
          setImportFeedback({
            state: 'error',
            message: `Could not import ${source.name}: ${message}`,
          })
          toast.error('Could not read Balatro game', { description: message })
        }
      } finally {
        activeImport.current = null
        setBusy(false)
      }
    },
    []
  )

  // Chromium: persist a handle for direct files, but only the inner .love for app ZIPs.
  const onPickExe = useCallback(async () => {
    try {
      const handle = await pickExeHandle()
      if (!handle) return
      const source = await handle.getFile()
      await applyExe(source, true, handle)
    } catch (e) {
      toast.error('Could not read Balatro game', {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }, [applyExe])

  // File/folder input: persist just the game archive, not the whole Mac bundle.
  const onExeFile = useCallback(
    async (source: File | null) => {
      if (!source) return
      await applyExe(source, true)
    },
    [applyExe]
  )

  const onAppFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      try {
        await onExeFile(findAppLove(files))
      } catch (e) {
        toast.error('Could not find Balatro.love in that folder', {
          description: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [onExeFile]
  )

  const onForgetExe = useCallback(async () => {
    setExeBuf(null)
    setSavedExe(null)
    setImportFeedback(null)
    await forgetExe()
  }, [])

  // On load, if we have a remembered exe, ask to re-import it. "No" forgets it.
  useEffect(() => {
    setCanPickHandle(supportsFsAccess())
    let cancelled = false
    recallExe().then((saved) => {
      if (cancelled || !saved) return
      setSavedExe(saved)
      setReimportOpen(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onReimportYes = useCallback(async () => {
    setReimportOpen(false)
    if (!savedExe) return
    try {
      const file = await fileFromSaved(savedExe)
      if (!file) {
        toast.error('Balatro game permission was declined', {
          description: 'It is still remembered — reload to try again.',
        })
        return
      }
      await applyExe(file)
    } catch (e) {
      toast.error('Could not re-import Balatro game', {
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }, [savedExe, applyExe])

  const onReimportNo = useCallback(async () => {
    setReimportOpen(false)
    setSavedExe(null)
    await forgetExe()
  }, [])

  const setObject = useCallback(
    (catId: string, key: string, edit: ObjectEdit | null) => {
      setProject((p) => {
        const objects = { ...p.objects }
        const id = objId(catId, key)
        if (
          edit &&
          (edit.sprites.some(Boolean) ||
            edit.soul ||
            edit.hideSoul ||
            edit.shader)
        )
          objects[id] = edit
        else delete objects[id]
        return { ...p, objects }
      })
    },
    []
  )

  const setSheetCell = useCallback(
    (sheetId: string, index: number, dataUrl: string | null) => {
      setProject((p) => {
        const sheets = { ...p.sheets }
        const cells = { ...(sheets[sheetId] ?? {}) }
        if (dataUrl) cells[index] = dataUrl
        else delete cells[index]
        if (Object.keys(cells).length === 0) delete sheets[sheetId]
        else sheets[sheetId] = cells
        return { ...p, sheets }
      })
    },
    []
  )

  const setLocValue = useCallback(
    (lang: string, path: string, value: string | string[] | null) => {
      setProject((p) => {
        const loc = { ...p.loc }
        const langEdits = { ...(loc[lang] ?? {}) }
        if (value === null || (Array.isArray(value) && value.length === 0))
          delete langEdits[path]
        else langEdits[path] = value
        if (Object.keys(langEdits).length === 0) delete loc[lang]
        else loc[lang] = langEdits
        return { ...p, loc }
      })
    },
    []
  )

  const setDeckSkins = useCallback(
    (next: SetStateAction<PlayingCardSkin[]>) => {
      setProject((previous) => {
        const current = migrateDeckSkins(previous)
        return {
          ...current,
          deckSkins:
            typeof next === 'function' ? next(current.deckSkins) : next,
        }
      })
    },
    []
  )

  const setOptions = useCallback((next: ProjectState['options']) => {
    setProject((p) => ({ ...p, options: next }))
  }, [])

  const loadLoc = useMemo(
    () => (exeBuf ? (lang: string) => readLocFromExe(exeBuf, lang) : null),
    [exeBuf]
  )

  const spriteCount =
    Object.keys(project.objects).length +
    Object.values(project.sheets).reduce(
      (n, c) => n + Object.keys(c).length,
      0
    ) +
    deckSkinSpriteCount(project.deckSkins ?? [])
  const langs = Object.keys(project.loc)
  const textCount = langs.reduce(
    (n, l) => n + Object.keys(project.loc[l]!).length,
    0
  )

  // Unsaved-changes guard: any edit marks the project dirty; generating a mod
  // clears it (and a later edit re-marks it), warning before leaving the page.
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    const sprites =
      Object.keys(project.objects).length +
      Object.values(project.sheets).reduce(
        (n, c) => n + Object.keys(c).length,
        0
      )
    const texts = Object.keys(project.loc).reduce(
      (n, l) => n + Object.keys(project.loc[l] ?? {}).length,
      0
    )
    setDirty(
      sprites > 0 ||
        texts > 0 ||
        Boolean(project.options.icon) ||
        (project.deckSkins?.length ?? 0) > 0
    )
  }, [project])
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function onGenerate() {
    setBusy(true)
    try {
      const { bytes, fileName, warnings } = await generatePack(project, catalog)
      const blob = new Blob([bytes.buffer as ArrayBuffer], {
        type: 'application/zip',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Generated ${fileName}`, {
        description: 'Unzip it into your Balatro Mods folder.',
      })
      setDirty(false)
      for (const w of warnings) toast.warning(w)
    } catch (e) {
      toast.error('Failed to generate pack', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  // Ranked export: a launcher-importable asset bundle for the Ranked-approved
  // ReskinStudioRanked mod, not an installable mod (see lib/generateRanked.ts).
  async function onGenerateRanked() {
    setBusy(true)
    try {
      const { bytes, fileName, warnings } = await generateRankedBundle(
        project,
        catalog
      )
      const blob = new Blob([bytes.buffer as ArrayBuffer], {
        type: 'application/zip',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Exported ${fileName}`, {
        description:
          'In the launcher: Tools > Manage Reskin Packs > Import Bundle. Needs the Reskin Studio Ranked mod.',
      })
      for (const w of warnings) toast.warning(w)
    } catch (e) {
      toast.error('Failed to export bundle', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  async function onMalverk(
    read: () => Promise<Map<string, Uint8Array>>,
    name: string
  ) {
    setBusy(true)
    try {
      const result = await importMalverkPack(await read(), canvasRasterIO, name)
      if (result.files.size === 0 && result.report.skipped.length === 0) {
        toast.error('Nothing could be imported from this pack')
        return
      }
      setMalverk({ result, name })
    } catch (e) {
      toast.error('Could not read this Malverk pack', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
      if (malverkZipRef.current) malverkZipRef.current.value = ''
      if (malverkDirRef.current) malverkDirRef.current.value = ''
    }
  }

  async function confirmMalverk() {
    if (!malverk) return
    setBusy(true)
    try {
      setProject(
        await importRankedBundle(
          malverk.result.files,
          catalog,
          malverk.result.suggestedName,
          (m) => toast.warning(m)
        )
      )
      toast.success('Malverk pack imported', {
        description:
          'Review it, then use Export for Ranked to make a bundle for the launcher.',
      })
      setMalverk(null)
    } catch (e) {
      toast.error('Could not load the converted pack', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  async function onImport(file: File) {
    setBusy(true)
    try {
      setProject(await importPack(file, catalog, (m) => toast.warning(m)))
      toast.success('Pack imported', {
        description: 'Your previous edits are loaded.',
      })
    } catch (e) {
      toast.error('Could not import pack', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
      if (importRef.current) importRef.current.value = ''
    }
  }

  return (
    <AssetModalProvider>
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3'>
          <div className='text-muted-foreground text-sm'>
            <span className='font-medium text-foreground'>{spriteCount}</span>{' '}
            sprite
            {spriteCount === 1 ? '' : 's'} ·{' '}
            <span className='font-medium text-foreground'>{textCount}</span>{' '}
            text edit
            {textCount === 1 ? '' : 's'} across{' '}
            <span className='font-medium text-foreground'>{langs.length}</span>{' '}
            language{langs.length === 1 ? '' : 's'}
          </div>
          <div className='flex items-center gap-2'>
            <input
              ref={importRef}
              type='file'
              accept='.zip'
              className='hidden'
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImport(f)
              }}
            />
            <Button
              variant='ghost'
              size='sm'
              disabled={busy}
              onClick={() => {
                if (confirm('Clear all edits and start over?'))
                  setProject(emptyProject())
              }}
            >
              <RotateCcw className='mr-1 size-4' /> Reset
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={() => importRef.current?.click()}
            >
              <Upload className='mr-1 size-4' /> Import pack
            </Button>
            <input
              ref={malverkZipRef}
              type='file'
              accept='.zip'
              className='hidden'
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f)
                  onMalverk(
                    () => filesFromZip(f),
                    f.name.replace(/\.zip$/i, '')
                  )
              }}
            />
            <input
              ref={malverkDirRef}
              type='file'
              className='hidden'
              // @ts-expect-error non-standard but widely supported folder picker
              webkitdirectory=''
              onChange={(e) => {
                const list = e.target.files
                if (list && list.length > 0)
                  onMalverk(
                    () => filesFromFolder(list),
                    (
                      list[0] as File & { webkitRelativePath?: string }
                    ).webkitRelativePath?.split('/')[0] ?? 'Malverk pack'
                  )
              }}
            />
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={() => malverkZipRef.current?.click()}
              title='Convert an uncompressed Malverk texture pack (.zip) into an editable pack. For a normal compressed zip, extract it and use Malverk folder.'
            >
              <Upload className='mr-1 size-4' /> Malverk zip
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={() => malverkDirRef.current?.click()}
              title='Convert an installed Malverk texture pack folder (also reads compressed packs)'
            >
              <Upload className='mr-1 size-4' /> Malverk folder
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={onGenerateRanked}
              title='Export textures and text as a bundle for the launcher (Ranked-legal). Requires the Reskin Studio Ranked mod.'
            >
              <Download className='mr-1 size-4' />
              Export for Ranked
            </Button>
            <Button size='sm' disabled={busy} onClick={onGenerate}>
              <Download className='mr-1 size-4' />
              {busy ? 'Working…' : 'Generate mod'}
            </Button>
          </div>
        </div>

        <ExeImport
          canPickHandle={canPickHandle}
          onPickExe={onPickExe}
          onExeFile={onExeFile}
          onAppFiles={onAppFiles}
          busy={busy}
          onForgetExe={onForgetExe}
          savedExeName={savedExe?.name ?? null}
          borderReady={Boolean(exeBuf)}
          importing={importFeedback?.state === 'working'}
        >
          {importFeedback && (
            <ImportStatus
              feedback={importFeedback}
              onCancel={() => activeImport.current?.abort()}
            />
          )}
        </ExeImport>

        <Tabs defaultValue='sprites'>
          <TabsList>
            <TabsTrigger value='sprites'>Sprites</TabsTrigger>
            <TabsTrigger value='localization'>Localization</TabsTrigger>
            <TabsTrigger value='options'>Options</TabsTrigger>
          </TabsList>
          <TabsContent value='sprites'>
            <AssetsTab
              catalog={catalog}
              project={project}
              setObject={setObject}
              setSheetCell={setSheetCell}
              setDeckSkins={setDeckSkins}
              exeBuf={exeBuf}
            />
          </TabsContent>
          <TabsContent value='localization'>
            <LocalizationTab
              catalog={catalog}
              loc={project.loc}
              setLocValue={setLocValue}
              loadLoc={loadLoc}
            />
          </TabsContent>
          <TabsContent value='options'>
            <OptionsTab
              options={project.options}
              setOptions={setOptions}
              exeBuf={exeBuf}
            />
          </TabsContent>
        </Tabs>

        <AlertDialog open={reimportOpen} onOpenChange={setReimportOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Import Balatro game again?</AlertDialogTitle>
              <AlertDialogDescription>
                You imported{' '}
                <span className='font-medium text-foreground'>
                  {savedExe?.name ?? 'Balatro game'}
                </span>{' '}
                last time. Re-import it to show vanilla art, the Joker border,
                and in-game text. Choosing <strong>No</strong> forgets it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={onReimportNo}>No</AlertDialogCancel>
              <AlertDialogAction onClick={onReimportYes}>Yes</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={malverk !== null}
          onOpenChange={(o) => !o && setMalverk(null)}
        >
          <AlertDialogContent className='max-h-[85vh] overflow-y-auto'>
            <AlertDialogHeader>
              <AlertDialogTitle>Import Malverk pack</AlertDialogTitle>
              <AlertDialogDescription>
                Nothing in the pack was run; only its texture definitions were
                read. Review what was found, then load it into the editor.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {malverk && <MalverkReportView result={malverk.result} />}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || malverk?.result.files.size === 0}
                onClick={(e) => {
                  e.preventDefault()
                  void confirmMalverk()
                }}
              >
                Load into editor
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AssetModalProvider>
  )
}

function MalverkReportView({ result }: { result: MalverkResult }) {
  const r = result.report
  return (
    <div className='space-y-3 text-sm'>
      {r.imported.length > 0 ? (
        <div>
          <div className='font-medium'>Imported</div>
          <ul className='list-disc pl-5 text-muted-foreground'>
            {r.imported.map((i) => (
              <li key={i.sheet}>
                {i.sheet}: {i.objects} object{i.objects === 1 ? '' : 's'} (from{' '}
                {i.from})
              </li>
            ))}
            {r.localization.length > 0 && (
              <li>text: {r.localization.join(', ')}</li>
            )}
            {r.sounds > 0 && (
              <li>
                {r.sounds} sound{r.sounds === 1 ? '' : 's'} (sounds are not
                editable here; use the launcher to import the pack directly)
              </li>
            )}
          </ul>
        </div>
      ) : (
        <div className='text-muted-foreground'>
          No textures could be imported.
        </div>
      )}
      {r.skipped.length > 0 && (
        <div>
          <div className='font-medium'>Skipped ({r.skipped.length})</div>
          <ul className='list-disc pl-5 text-muted-foreground'>
            {r.skipped.slice(0, 20).map((k, i) => (
              <li key={`${k.what}-${i}`}>
                {k.what}: {k.reason}
              </li>
            ))}
            {r.skipped.length > 20 && <li>and {r.skipped.length - 20} more</li>}
          </ul>
        </div>
      )}
      {r.warnings.length > 0 && (
        <div>
          <div className='font-medium'>Notes ({r.warnings.length})</div>
          <ul className='list-disc pl-5 text-muted-foreground'>
            {r.warnings.slice(0, 20).map((w, i) => (
              <li key={`${i}-${w.slice(0, 20)}`}>{w}</li>
            ))}
            {r.warnings.length > 20 && (
              <li>and {r.warnings.length - 20} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
