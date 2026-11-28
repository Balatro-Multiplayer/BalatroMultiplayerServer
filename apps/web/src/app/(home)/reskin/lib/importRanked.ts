// Load a ReskinStudioRanked bundle (see that repo's FORMAT.md, and
// generateRanked.ts) back into the editor so a saved pack can be remade.
//
// Deliberately conservative: it reads only STORE zips through the existing
// reader (no new decompressor), only the allow-listed bundle paths, enforces
// the same size caps as the launcher, requires exact vanilla sheet dimensions,
// and treats all text as inert data. Nothing from the bundle is evaluated.
// Only the final art is recovered (no uncropped source, edge or fit settings).

import { posFor } from './atlasOverrides'
import {
  atlasFile,
  CARDS_FILE,
  CARDS_SIZE,
  CHIPS_FILE,
  deckSkinFile,
  MAX_ATLAS_SIDE,
  MAX_ATLASES,
  MAX_DECK_SKINS,
  MAX_FRAMES,
  RANKED_SHEETS,
  SHOP_SIGN,
  SHOP_SIGN_FILE,
} from './generateRanked'
import { loadImage } from './image'
import {
  type Catalog,
  emptyProject,
  type LocEdits,
  type ObjectEdit,
  objId,
  type PlayingCardSkin,
  type ProjectState,
  SHADER_OPTIONS,
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
const ID = /^[a-z0-9_]{1,40}$/
const KEY = /^[A-Za-z0-9_]{1,64}$/
const REGISTRIES = new Set([
  'P_CENTERS',
  'P_BLINDS',
  'P_TAGS',
  'P_SEALS',
  'P_STAKES',
])
const DEFAULT_FPS = 10
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** True when the zip looks like a Ranked bundle rather than a Studio project. */
export function looksLikeRankedBundle(files: Map<string, Uint8Array>): boolean {
  for (const name of files.keys()) {
    if (
      name === 'reskin.json' ||
      name.startsWith('assets/') ||
      name.startsWith('localization/')
    )
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
    new Blob(
      [
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
      ],
      {
        type: 'image/png',
      }
    )
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
    if (
      path.length > 0 &&
      node.every((x) => typeof x === 'string' && x.length <= MAX_STRING)
    ) {
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
  if (rawFiles.size > MAX_FILES)
    throw new Error('This bundle has too many files.')
  const files = unwrap(rawFiles)
  const project = emptyProject()
  project.options.displayName = displayName || project.options.displayName

  // reskin.json: which objects each sheet covers (absent = all objects).
  const keysBySheet = new Map<string, Set<string>>()
  let rawCfg: {
    deckSkins?: unknown
    atlases?: unknown
    objects?: unknown
    shaders?: unknown
  } = {}
  const cfgBytes = files.get('reskin.json')
  if (cfgBytes) {
    if (cfgBytes.length > MAX_JSON) throw new Error('reskin.json is too large.')
    const cfg = JSON.parse(unzipText(cfgBytes)) as {
      sheets?: Record<string, { keys?: unknown }>
      custom?: Record<string, unknown>
      deckSkins?: unknown
      atlases?: unknown
      objects?: unknown
      shaders?: unknown
    }
    rawCfg = cfg
    // Custom sheets are art for objects added by other mods; the Studio only
    // edits vanilla objects, so they are not loaded (and not re-exported).
    const customCount =
      cfg.custom && typeof cfg.custom === 'object'
        ? Object.keys(cfg.custom).length
        : 0
    if (customCount > 0)
      onWarning?.(
        `${customCount} custom sheet${customCount === 1 ? '' : 's'} (art for other mods' objects) can't be edited in the Studio and ${customCount === 1 ? 'was' : 'were'} not loaded. Keep the original bundle to use ${customCount === 1 ? 'it' : 'them'}.`
      )
    for (const [sheet, v] of Object.entries(cfg.sheets ?? {})) {
      if (Array.isArray(v?.keys))
        keysBySheet.set(
          sheet,
          new Set(v.keys.filter((k): k is string => typeof k === 'string'))
        )
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
      throw new Error(
        `${spec.file}.png is not a valid PNG within the size limit.`
      )

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

  // Sheets that are not per-object categories (see generateRanked.ts).
  const readSheet = async (file: string, w: number, h: number) => {
    let scale = 1
    let bytes = files.get(`assets/1x/${file}.png`)
    if (!bytes) {
      scale = 2
      bytes = files.get(`assets/2x/${file}.png`)
    }
    if (!bytes) return null
    if (bytes.length > MAX_PNG || !isPng(bytes))
      throw new Error(`${file}.png is not a valid PNG within the size limit.`)
    const img = await decodePng(bytes)
    if (img.naturalWidth !== w * scale || img.naturalHeight !== h * scale)
      throw new Error(
        `${file}.png must be exactly ${w * scale}x${h * scale} (it is ${img.naturalWidth}x${img.naturalHeight}).`
      )
    return { img, scale }
  }

  const chipSheet = catalog.spriteSheets.find((s) => s.id === 'chips')
  if (chipSheet) {
    const cols = chipSheet.cols ?? 1
    const rows = chipSheet.rows ?? 1
    const sheet = await readSheet(
      CHIPS_FILE,
      cols * chipSheet.px,
      rows * chipSheet.py
    )
    if (sheet) {
      const only = keysBySheet.get(CHIPS_FILE)
      const edits: Record<number, string> = {}
      chipSheet.cells.forEach((cell, index) => {
        if (!cell.key || (only && !only.has(cell.key))) return
        const url = cutCell(
          sheet.img,
          sheet.scale,
          index % cols,
          Math.floor(index / cols),
          chipSheet.px,
          chipSheet.py
        )
        if (url) edits[index] = url
      })
      if (Object.keys(edits).length > 0) {
        project.sheets.chips = edits
        importedAny = true
      }
    }
  }

  const sign = await readSheet(
    SHOP_SIGN_FILE,
    SHOP_SIGN.px * SHOP_SIGN.frames,
    SHOP_SIGN.py
  )
  if (sign) {
    const edits: Record<number, string> = {}
    for (let f = 0; f < SHOP_SIGN.frames; f++) {
      const url = cutCell(
        sign.img,
        sign.scale,
        f,
        0,
        SHOP_SIGN.px,
        SHOP_SIGN.py
      )
      if (url) edits[f] = url
    }
    if (Object.keys(edits).length > 0) {
      project.sheets.shop_sign = edits
      importedAny = true
    }
  }

  // Playing cards: deck skins, plus a whole-sheet cards.png (it replaces the
  // game's default faces; the editor models it as one more card skin).
  const skins: PlayingCardSkin[] = []
  const skinCfg = rawCfg.deckSkins
  if (skinCfg && typeof skinCfg === 'object' && !Array.isArray(skinCfg)) {
    for (const [id, v] of Object.entries(skinCfg as Record<string, unknown>)) {
      if (skins.length >= MAX_DECK_SKINS) break
      if (!ID.test(id) || !v || typeof v !== 'object') continue
      const rawName = (v as { name?: unknown }).name
      const skin: PlayingCardSkin = {
        id,
        name:
          typeof rawName === 'string' && rawName ? rawName.slice(0, 64) : id,
      }
      for (const contrast of ['lc', 'hc'] as const) {
        const sheet = await readSheet(
          deckSkinFile(id, contrast),
          CARDS_SIZE.w,
          CARDS_SIZE.h
        )
        const url =
          sheet &&
          cutCell(sheet.img, sheet.scale, 0, 0, CARDS_SIZE.w, CARDS_SIZE.h)
        if (url) skin[contrast === 'lc' ? 'low' : 'high'] = url
      }
      if (skin.low || skin.high) skins.push(skin)
    }
  }
  const faces = await readSheet(CARDS_FILE, CARDS_SIZE.w, CARDS_SIZE.h)
  if (faces) {
    const url = cutCell(
      faces.img,
      faces.scale,
      0,
      0,
      CARDS_SIZE.w,
      CARDS_SIZE.h
    )
    if (url) {
      let id = 'default_faces'
      while (skins.some((k) => k.id === id)) id += '_old'
      skins.push({ id, name: project.options.displayName, low: url })
    }
  }
  if (skins.length > 0) {
    project.deckSkins = skins
    importedAny = true
  }

  // Rebinds: animations and soul layers that point single objects at atlas cells.
  const whole = (n: unknown, lo: number, hi: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi
  type AtlasDef = { px: number; py: number; frames?: number; fps?: number }
  const atlasDefs = new Map<string, AtlasDef>()
  const atlasCfg = rawCfg.atlases
  if (atlasCfg && typeof atlasCfg === 'object' && !Array.isArray(atlasCfg)) {
    for (const [name, v] of Object.entries(
      atlasCfg as Record<string, unknown>
    )) {
      if (atlasDefs.size >= MAX_ATLASES) break
      const a = v as Partial<AtlasDef> | null
      if (!ID.test(name) || !a || typeof a !== 'object') continue
      if (!whole(a.px, 1, 256) || !whole(a.py, 1, 256)) continue
      if (a.frames !== undefined && !whole(a.frames, 1, MAX_FRAMES)) continue
      const fps =
        typeof a.fps === 'number' && a.fps >= 1 && a.fps <= 60
          ? a.fps
          : undefined
      atlasDefs.set(name, { px: a.px, py: a.py, frames: a.frames, fps })
    }
  }
  const atlasImages = new Map<
    string,
    { img: HTMLImageElement; scale: number; cols: number; rows: number } | null
  >()
  const readAtlas = async (name: string) => {
    if (atlasImages.has(name)) return atlasImages.get(name)!
    const def = atlasDefs.get(name)
    let scale = 1
    let bytes = files.get(`assets/1x/${atlasFile(name)}.png`)
    if (!bytes) {
      scale = 2
      bytes = files.get(`assets/2x/${atlasFile(name)}.png`)
    }
    let result: {
      img: HTMLImageElement
      scale: number
      cols: number
      rows: number
    } | null = null
    if (def && bytes) {
      if (bytes.length > MAX_PNG || !isPng(bytes))
        throw new Error(
          `${atlasFile(name)}.png is not a valid PNG within the size limit.`
        )
      const img = await decodePng(bytes)
      const cw = def.px * scale
      const ch = def.py * scale
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (
        w % cw !== 0 ||
        h % ch !== 0 ||
        w > MAX_ATLAS_SIDE * scale ||
        h > MAX_ATLAS_SIDE * scale ||
        (def.frames !== undefined && (w !== def.frames * cw || h !== ch))
      )
        throw new Error(
          `${atlasFile(name)}.png is ${w}x${h}, which doesn't match its declared ${def.px}x${def.py} cells.`
        )
      result = { img, scale, cols: w / cw, rows: h / ch }
    }
    atlasImages.set(name, result)
    return result
  }

  const byObject = new Map<
    string,
    { catId: string; key: string; soul: boolean; frames: number }
  >()
  const byKey = new Map<string, { catId: string; key: string }>()
  for (const cat of catalog.spriteCategories) {
    for (const o of catalog.spriteObjects[cat.id] ?? []) {
      byObject.set(`${cat.registry}/${o.key}`, {
        catId: cat.id,
        key: o.key,
        soul: Boolean(o.soul),
        frames: cat.frames,
      })
      byKey.set(o.key, { catId: cat.id, key: o.key })
    }
  }
  const editFor = (catId: string, key: string): ObjectEdit => {
    const id = objId(catId, key)
    const existing = project.objects[id]
    if (existing) return existing
    const created: ObjectEdit = { sprites: [] }
    project.objects[id] = created
    return created
  }

  const objectsCfg = Array.isArray(rawCfg.objects)
    ? rawCfg.objects.slice(0, 1000)
    : []
  for (const raw of objectsCfg) {
    const o = raw as {
      registry?: unknown
      key?: unknown
      atlas?: unknown
      x?: unknown
      y?: unknown
      soul_atlas?: unknown
      soul_x?: unknown
      soul_y?: unknown
    } | null
    if (!o || typeof o !== 'object') continue
    if (typeof o.registry !== 'string' || !REGISTRIES.has(o.registry)) continue
    if (typeof o.key !== 'string' || !KEY.test(o.key)) continue
    const target = byObject.get(`${o.registry}/${o.key}`)
    if (!target) continue // an object the Studio doesn't edit (another mod's, say)

    if (typeof o.atlas === 'string' && target.frames <= 1) {
      const def = atlasDefs.get(o.atlas)
      const sheet = def && (await readAtlas(o.atlas))
      if (def && sheet) {
        const x = whole(o.x, 0, 255) ? o.x : 0
        const y = whole(o.y, 0, 255) ? o.y : 0
        const sprites: string[] = []
        if (def.frames) {
          for (let f = 0; f < def.frames; f++) {
            const cell = cutCell(sheet.img, sheet.scale, f, 0, def.px, def.py)
            if (cell) sprites.push(cell)
          }
        } else if (x < sheet.cols && y < sheet.rows) {
          const cell = cutCell(sheet.img, sheet.scale, x, y, def.px, def.py)
          if (cell) sprites.push(cell)
        }
        if (sprites.length > 0) {
          const edit = editFor(target.catId, target.key)
          edit.sprites = sprites
          if (sprites.length === 1) {
            edit.base = sprites[0]
            edit.render = {}
          } else {
            edit.fps = def.fps ?? DEFAULT_FPS
          }
          importedAny = true
        }
      }
    }

    if (typeof o.soul_atlas === 'string') {
      const def = atlasDefs.get(o.soul_atlas)
      const sheet = def && (await readAtlas(o.soul_atlas))
      if (def && sheet) {
        const x = whole(o.soul_x, 0, 255) ? o.soul_x : 0
        const y = whole(o.soul_y, 0, 255) ? o.soul_y : 0
        if (x < sheet.cols && y < sheet.rows) {
          const cell = cutCell(sheet.img, sheet.scale, x, y, def.px, def.py)
          const edit = editFor(target.catId, target.key)
          if (cell) edit.soul = cell
          else edit.hideSoul = true
          importedAny = true
        }
      }
    }
  }

  // Default shaders.
  const shaderNames = new Set<string>(SHADER_OPTIONS)
  const shadersCfg = Array.isArray(rawCfg.shaders)
    ? rawCfg.shaders.slice(0, 1000)
    : []
  for (const raw of shadersCfg) {
    const s = raw as { key?: unknown; shader?: unknown } | null
    if (!s || typeof s.key !== 'string' || !KEY.test(s.key)) continue
    if (typeof s.shader !== 'string' || !shaderNames.has(s.shader)) continue
    const target = byKey.get(s.key)
    if (!target) continue
    editFor(target.catId, target.key).shader = s.shader
    importedAny = true
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
