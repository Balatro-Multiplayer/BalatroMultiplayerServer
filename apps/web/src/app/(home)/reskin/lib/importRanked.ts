// Load a ReskinStudioRanked bundle (see that repo's FORMAT.md, and
// generateRanked.ts) back into the editor so a saved pack can be remade.
//
// Deliberately conservative: it reads only STORE zips through the existing
// reader (no new decompressor), only the allow-listed bundle paths, enforces
// the same size caps as the launcher, requires exact vanilla sheet dimensions,
// and treats all text as inert data. Nothing from the bundle is evaluated.
// Only the final art is recovered (no uncropped source, edge or fit settings).

import { posFor } from './atlasOverrides'
import { RANKED_SHEETS } from './generateRanked'
import { loadImage } from './image'
import {
  type Catalog,
  emptyProject,
  type LocEdits,
  type ObjectEdit,
  objId,
  type ProjectState,
} from './types'
import { unzipText } from './zip'

const MAX_FILES = 400
const MAX_PNG = 8 * 1024 * 1024
const MAX_JSON = 1024 * 1024
const MAX_DEPTH = 8
const MAX_STRING = 4000
const MAX_LOC_ENTRIES = 50_000
const LANG = /^[A-Za-z0-9_-]+$/
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** True when the zip looks like a Ranked bundle rather than a Studio project. */
export function looksLikeRankedBundle(files: Map<string, Uint8Array>): boolean {
  for (const name of files.keys()) {
    if (name === 'reskin.json' || name.startsWith('assets/') || name.startsWith('localization/'))
      return true
    if (/^[^/]+\/(reskin\.json|assets\/|localization\/)/.test(name)) return true
  }
  return false
}

/** Drop one shared wrapper folder, if every entry sits inside the same one. */
function unwrap(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const first = [...files.keys()][0]
  const slash = first?.indexOf('/') ?? -1
  if (!first || slash < 0) return files
  const prefix = first.slice(0, slash + 1)
  for (const n of files.keys()) if (!n.startsWith(prefix)) return files
  return new Map([...files].map(([n, b]) => [n.slice(prefix.length), b]))
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && PNG_SIG.every((v, i) => b[i] === v)
}

async function decodePng(bytes: Uint8Array): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(
    new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
      type: 'image/png',
    })
  )
  try {
    return await loadImage(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function cutCell(
  img: HTMLImageElement,
  scale: number,
  col: number,
  row: number,
  px: number,
  py: number
): string | null {
  const cw = px * scale
  const ch = py * scale
  const c = document.createElement('canvas')
  c.width = px
  c.height = py
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas context unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, col * cw, row * ch, cw, ch, 0, 0, px, py)
  const data = ctx.getImageData(0, 0, px, py).data
  let any = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) {
      any = true
      break
    }
  }
  return any ? c.toDataURL('image/png') : null
}

function flattenLoc(
  node: unknown,
  path: string[],
  out: Record<string, string | string[]>,
  counter: { n: number }
): void {
  if (path.length > MAX_DEPTH || counter.n > MAX_LOC_ENTRIES) return
  if (typeof node === 'string') {
    if (node.length <= MAX_STRING && path.length > 0) {
      out[path.join('.')] = node
      counter.n++
    }
  } else if (Array.isArray(node)) {
    if (path.length > 0 && node.every((x) => typeof x === 'string' && x.length <= MAX_STRING)) {
      out[path.join('.')] = node as string[]
      counter.n++
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_SEGMENTS.has(k) || k.includes('.')) continue
      flattenLoc(v, [...path, k], out, counter)
    }
  }
}

export async function importRankedBundle(
  rawFiles: Map<string, Uint8Array>,
  catalog: Catalog,
  displayName: string,
  onWarning?: (message: string) => void
): Promise<ProjectState> {
  if (rawFiles.size > MAX_FILES) throw new Error('This bundle has too many files.')
  const files = unwrap(rawFiles)
  const project = emptyProject()
  project.options.displayName = displayName || project.options.displayName

  // reskin.json: which objects each sheet covers (absent = all objects).
  const keysBySheet = new Map<string, Set<string>>()
  const cfgBytes = files.get('reskin.json')
  if (cfgBytes) {
    if (cfgBytes.length > MAX_JSON) throw new Error('reskin.json is too large.')
    const cfg = JSON.parse(unzipText(cfgBytes)) as {
      sheets?: Record<string, { keys?: unknown }>
      custom?: Record<string, unknown>
    }
    // Custom sheets are art for objects added by other mods; the Studio only
    // edits vanilla objects, so they are not loaded (and not re-exported).
    const customCount =
      cfg.custom && typeof cfg.custom === 'object' ? Object.keys(cfg.custom).length : 0
    if (customCount > 0)
      onWarning?.(
        `${customCount} custom sheet${customCount === 1 ? '' : 's'} (art for other mods' objects) can't be edited in the Studio and ${customCount === 1 ? 'was' : 'were'} not loaded. Keep the original bundle to use ${customCount === 1 ? 'it' : 'them'}.`
      )
    for (const [sheet, v] of Object.entries(cfg.sheets ?? {})) {
      if (Array.isArray(v?.keys))
        keysBySheet.set(sheet, new Set(v.keys.filter((k): k is string => typeof k === 'string')))
    }
  }

  let importedAny = false

  for (const cat of catalog.spriteCategories) {
    const spec = RANKED_SHEETS[cat.id]
    if (!spec) continue

    let scale = 1
    let bytes = files.get(`assets/1x/${spec.file}.png`)
    if (!bytes) {
      scale = 2
      bytes = files.get(`assets/2x/${spec.file}.png`)
    }
    if (!bytes) continue
    if (bytes.length > MAX_PNG || !isPng(bytes))
      throw new Error(`${spec.file}.png is not a valid PNG within the size limit.`)

    const img = await decodePng(bytes)
    if (
      img.naturalWidth !== spec.cols * cat.px * scale ||
      img.naturalHeight !== spec.rows * cat.py * scale
    )
      throw new Error(
        `${spec.file}.png must be exactly ${spec.cols * cat.px * scale}x${spec.rows * cat.py * scale} (it is ${img.naturalWidth}x${img.naturalHeight}).`
      )

    const only = keysBySheet.get(spec.file)
    for (const o of catalog.spriteObjects[cat.id] ?? []) {
      if (only && !only.has(o.key)) continue
      const pos = posFor(cat.id, o)
      if (!pos) continue

      const sprites: string[] = []
      if (cat.frames > 1) {
        for (let f = 0; f < cat.frames; f++) {
          const cell = cutCell(img, scale, f, pos.y, cat.px, cat.py)
          if (cell) sprites.push(cell)
        }
        // A blind needs every frame; partial rows would misalign the animation.
        if (sprites.length !== cat.frames) continue
      } else {
        const cell = cutCell(img, scale, pos.x, pos.y, cat.px, cat.py)
        if (cell) sprites.push(cell)
      }
      if (sprites.length === 0) continue

      const edit: ObjectEdit = { sprites }
      if (sprites.length === 1) {
        edit.base = sprites[0]
        edit.render = {}
      }
      project.objects[objId(cat.id, o.key)] = edit
      importedAny = true
    }
  }

  // Localization: inert JSON -> the editor's dot-path edits.
  const loc: LocEdits = {}
  for (const [name, bytes] of files) {
    const m = /^localization\/([A-Za-z0-9_-]+)\.json$/.exec(name)
    if (!m || !LANG.test(m[1]!)) continue
    if (bytes.length > MAX_JSON) throw new Error(`${name} is too large.`)
    const flat: Record<string, string | string[]> = {}
    flattenLoc(JSON.parse(unzipText(bytes)), [], flat, { n: 0 })
    if (Object.keys(flat).length > 0) {
      loc[m[1]!] = flat
      importedAny = true
    }
  }
  project.loc = loc

  if (!importedAny)
    throw new Error(
      'No sprites or text could be read from this bundle. Only uncompressed zips made by the Studio\'s "Export for Ranked" are supported.'
    )
  return project
}
