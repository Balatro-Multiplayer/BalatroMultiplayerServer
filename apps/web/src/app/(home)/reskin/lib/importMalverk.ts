// Convert an existing Malverk texture pack into a ReskinStudioRanked bundle
// (see that repo's MALVERK_IMPORT.md, which this follows section by section,
// and FORMAT.md for the output layout).
//
// The pack is untrusted third-party code: nothing in it is ever executed.
// Definitions are read as literals by luaLiteral.ts, images are decoded only
// after their PNG header passes the size limits, and the output is a plain
// bundle (PNG + JSON + OGG) that importRankedBundle() / the launcher re-validate.
//
// Pixel I/O is injected (RasterIO) so the layout logic is testable without a
// browser; the real implementation lives in malverkRaster.ts.

import positionsJson from '../data/positions.json'
import {
  extractDefinitions,
  isTruthy,
  getNumber,
  getString,
  getStringList,
  getTable,
  isFieldUnresolved,
  type LuaTable,
  LuaLimitError,
  parseReturnTable,
  UNRESOLVED,
} from './luaLiteral'

// ---- limits (MALVERK_IMPORT.md section 1) ----------------------------------
export const MAX_FILES = 2000
export const MAX_LUA_FILE = 2 * 1024 * 1024
export const MAX_LUA_TOTAL = 16 * 1024 * 1024
export const MAX_PNG_BYTES = 16 * 1024 * 1024
export const MAX_PNG_DIM = 16384
export const MAX_PNG_PIXELS = 64 * 1024 * 1024
export const MAX_OGG_BYTES = 20 * 1024 * 1024
const MAX_JSON = 1024 * 1024
const MAX_LOC_DEPTH = 8
const MAX_LOC_STRING = 4000
const MAX_LOC_ENTRIES = 50_000
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

// Tarots, planets and spectrals are one atlas in the game, and Malverk lets a
// texture of any of the three list keys of the others.
const CONSUMABLE_SHEETS = ['tarots', 'planets', 'spectrals']
// Object types a custom sheet (art for a mod's own objects) may target.
// Must match ReskinStudioRanked's FORMAT.md "Custom sheets".
const CUSTOM_SETS = new Set([
  'Joker',
  'Tarot',
  'Planet',
  'Spectral',
  'Voucher',
  'Booster',
  'Enhanced',
  'Back',
])
const CUSTOM_COLUMNS = 10

interface CustomSheet {
  slug: string
  set: string
  px: number
  py: number
  from: string
  entries: { key: string; cell: Raster }[]
}

// A name matching ^[a-z0-9_]{1,32}$, unique among this import's custom sheets.
function customSlug(raw: string, used: Set<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || 'sheet'
  let slug = base
  for (let n = 2; used.has(slug); n++) slug = `${base}_${n}`
  used.add(slug)
  return slug
}

export interface Raster {
  w: number
  h: number
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray
}

export interface RasterIO {
  decode(bytes: Uint8Array): Promise<Raster>
  encode(r: Raster): Promise<Uint8Array>
}

export interface MalverkReport {
  imported: { sheet: string; objects: number; from: string }[]
  localization: string[]
  sounds: number
  skipped: { what: string; reason: string }[]
  warnings: string[]
}

export interface MalverkResult {
  /** A Ranked bundle: reskin.json, assets/..., localization/... (empty if nothing imported). */
  files: Map<string, Uint8Array>
  report: MalverkReport
  suggestedName: string
}

interface SheetInfo {
  set: string
  cellW: number
  cellH: number
  cols: number
  rows: number
  frames?: number
  cells: Record<string, [number, number]>
}
const SHEETS = (
  positionsJson as unknown as { sheets: Record<string, SheetInfo> }
).sheets
const SHEET_BY_SET = new Map(
  Object.entries(SHEETS).map(([file, s]) => [s.set, file])
)
/** Localization table each set's text lives under (Malverk puts boosters in `Other`). */
const LOC_SET: Record<string, string> = { Booster: 'Other' }

const dec = new TextDecoder('utf-8')
const enc = new TextEncoder()

// ---- file set ---------------------------------------------------------------

function checkNames(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.size > MAX_FILES) throw new Error('This pack has too many files.')
  const out = new Map<string, Uint8Array>()
  for (const [raw, bytes] of files) {
    if (raw.endsWith('/')) continue // directory entry
    if (
      /(^|\/)\.\.(\/|$)/.test(raw) ||
      raw.startsWith('/') ||
      raw.includes('\\') ||
      /^[A-Za-z]:/.test(raw)
    )
      throw new Error(`Unsafe path in pack: ${raw.slice(0, 80)}`)
    out.set(raw, bytes)
  }
  return out
}

interface Pack {
  root: string
  /** root-relative path -> bytes */
  files: Map<string, Uint8Array>
  lower: Map<string, string>
  name: string | null
}

function findPack(files: Map<string, Uint8Array>): Pack {
  let best: { dir: string; depth: number; name: string | null } | null = null
  const consider = (dir: string, name: string | null) => {
    const depth = dir === '' ? 0 : dir.split('/').length
    if (!best || depth < best.depth) best = { dir, depth, name }
  }
  for (const [path, bytes] of files) {
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash)
    if (/\.json$/i.test(path) && bytes.length <= MAX_JSON) {
      try {
        const j = JSON.parse(dec.decode(bytes)) as Record<string, unknown>
        if (j && typeof j.id === 'string' && typeof j.main_file === 'string')
          consider(dir, typeof j.name === 'string' ? j.name : null)
      } catch {
        /* not a manifest */
      }
    } else if (/\.lua$/i.test(path)) {
      const head = dec
        .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
        .replace(/^﻿/, '')
      if (head.startsWith('--- STEAMODDED HEADER')) {
        const m = /--- MOD_NAME:\s*([^\r\n]+)/.exec(head)
        consider(dir, m ? m[1]!.trim() : null)
      }
    }
  }
  let root = ''
  let name: string | null = null
  if (best) {
    root = (best as { dir: string }).dir
    name = (best as { name: string | null }).name
  } else {
    // No manifest: the shallowest folder that contains `assets/`.
    let depth = Infinity
    for (const path of files.keys()) {
      const i = path.indexOf('assets/')
      if (i === 0 || (i > 0 && path[i - 1] === '/')) {
        const dir = i === 0 ? '' : path.slice(0, i - 1)
        const d = dir === '' ? 0 : dir.split('/').length
        if (d < depth) {
          depth = d
          root = dir
        }
      }
    }
  }
  const prefix = root === '' ? '' : `${root}/`
  const rel = new Map<string, Uint8Array>()
  const lower = new Map<string, string>()
  for (const [p, b] of files) {
    if (!p.startsWith(prefix)) continue
    const r = p.slice(prefix.length)
    rel.set(r, b)
    lower.set(r.toLowerCase(), r)
  }
  return { root, files: rel, lower, name }
}

function lookup(
  pack: Pack,
  rel: string
): { path: string; bytes: Uint8Array } | null {
  const exact = pack.files.get(rel)
  if (exact) return { path: rel, bytes: exact }
  const alt = pack.lower.get(rel.toLowerCase())
  const b = alt ? pack.files.get(alt) : undefined
  return alt && b ? { path: alt, bytes: b } : null
}

function safeLeaf(name: string): boolean {
  return name.length > 0 && !/[\\/]/.test(name) && !name.includes('..')
}

// ---- PNG header / raster helpers --------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Read width/height from the IHDR and enforce the size limits BEFORE decoding. */
export function checkPngHeader(b: Uint8Array): { w: number; h: number } {
  if (b.length > MAX_PNG_BYTES) throw new Error('PNG file is too large')
  if (
    b.length < 24 ||
    !PNG_SIG.every((v, i) => b[i] === v) ||
    dec.decode(b.subarray(12, 16)) !== 'IHDR'
  )
    throw new Error('not a valid PNG')
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const w = dv.getUint32(16)
  const h = dv.getUint32(20)
  if (
    w === 0 ||
    h === 0 ||
    w > MAX_PNG_DIM ||
    h > MAX_PNG_DIM ||
    w * h > MAX_PNG_PIXELS
  )
    throw new Error(`PNG dimensions ${w}x${h} exceed the import limits`)
  return { w, h }
}

function newRaster(w: number, h: number): Raster {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) }
}

function hasAlpha(
  r: Raster,
  sx: number,
  sy: number,
  sw: number,
  sh: number
): boolean {
  for (let y = sy; y < sy + sh; y++) {
    let o = (y * r.w + sx) * 4 + 3
    for (let x = 0; x < sw; x++, o += 4) if (r.data[o] !== 0) return true
  }
  return false
}

/** Nearest-neighbour copy of a source rectangle into a destination rectangle. */
function blitNearest(
  src: Raster,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dst: Raster,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  for (let y = 0; y < dh; y++) {
    const syy = sy + Math.floor((y * sh) / dh)
    for (let x = 0; x < dw; x++) {
      const sxx = sx + Math.floor((x * sw) / dw)
      const s = (syy * src.w + sxx) * 4
      const d = ((dy + y) * dst.w + dx + x) * 4
      dst.data[d] = src.data[s]!
      dst.data[d + 1] = src.data[s + 1]!
      dst.data[d + 2] = src.data[s + 2]!
      dst.data[d + 3] = src.data[s + 3]!
    }
  }
}

/** 1x from a 2x sheet: every other pixel (nearest). */
function halve(r: Raster): Raster {
  const out = newRaster(r.w / 2, r.h / 2)
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) {
      const s = (y * 2 * r.w + x * 2) * 4
      const d = (y * out.w + x) * 4
      out.data[d] = r.data[s]!
      out.data[d + 1] = r.data[s + 1]!
      out.data[d + 2] = r.data[s + 2]!
      out.data[d + 3] = r.data[s + 3]!
    }
  return out
}

// ---- model -------------------------------------------------------------------

interface Texture {
  id: string // key, or "<file>#n" when keyless
  key: string | undefined
  file: string
  set: string
  sheet: string
  path: string
  keys: string[] | null
  original: boolean
  frames: number | undefined
  px: number | undefined
  py: number | undefined
  soulKeys: Set<string>
  loc: LuaTable | null
}

interface Cover {
  frames: Raster[] // output-resolution (2x) cells; one entry per frame
  from: string
}

// ---- localization -------------------------------------------------------------

type LocNode = string | string[] | { [k: string]: LocNode }

function luaToLoc(
  t: LuaTable,
  depth: number,
  counter: { n: number }
): LocNode | null {
  if (depth > MAX_LOC_DEPTH || counter.n > MAX_LOC_ENTRIES) return null
  // Pure positional string table -> array of strings
  if (t.fields.size === 0 && t.array.length > 0) {
    const arr: string[] = []
    for (const v of t.array) {
      if (typeof v !== 'string' || enc.encode(v).length > MAX_LOC_STRING)
        return null
      arr.push(v)
    }
    counter.n++
    return arr
  }
  const obj: { [k: string]: LocNode } = Object.create(null)
  for (const [k, v] of t.fields) {
    if (FORBIDDEN.has(k) || k.includes('.') || v === UNRESOLVED) continue
    if (typeof v === 'string') {
      if (enc.encode(v).length > MAX_LOC_STRING) continue
      obj[k] = v
      counter.n++
    } else if (v && typeof v === 'object') {
      const child = luaToLoc(v, depth + 1, counter)
      if (child !== null) obj[k] = child
    }
  }
  return Object.keys(obj).length > 0 ? obj : null
}

function mergeLoc(
  into: { [k: string]: LocNode },
  from: { [k: string]: LocNode }
): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k]
    if (
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      typeof v === 'object' &&
      !Array.isArray(v)
    )
      mergeLoc(cur as { [k: string]: LocNode }, v as { [k: string]: LocNode })
    else into[k] = v
  }
}

function dropMalverkUiText(root: { [k: string]: LocNode }): void {
  const d = root.descriptions
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    delete (d as Record<string, LocNode>).alt_texture
    delete (d as Record<string, LocNode>).texture_packs
  }
}

// ---- main ----------------------------------------------------------------------

export async function importMalverkPack(
  rawFiles: Map<string, Uint8Array>,
  io: RasterIO,
  fallbackName = 'Malverk pack'
): Promise<MalverkResult> {
  const report: MalverkReport = {
    imported: [],
    localization: [],
    sounds: 0,
    skipped: [],
    warnings: [],
  }
  const skip = (what: string, reason: string) =>
    report.skipped.push({ what, reason })
  const warn = (m: string) => report.warnings.push(m)

  const pack = findPack(checkNames(rawFiles))
  const out = new Map<string, Uint8Array>()

  // --- Lua: collect definitions ---------------------------------------------
  const luaFiles = [...pack.files.keys()]
    .filter((p) => /\.lua$/i.test(p))
    .sort()
  let luaTotal = 0
  const textures: Texture[] = []
  const packs: {
    key: string | undefined
    textures: string[]
    toggles: string[]
  }[] = []
  const sounds: { path: string; replace: string }[] = []
  const locSources = new Map<string, { [k: string]: LocNode }[]>() // lang -> tables, in order

  try {
    for (const path of luaFiles) {
      const bytes = pack.files.get(path)!
      if (bytes.length > MAX_LUA_FILE)
        throw new Error(
          `${path} is larger than the ${MAX_LUA_FILE >> 20} MiB limit.`
        )
      luaTotal += bytes.length
      if (luaTotal > MAX_LUA_TOTAL)
        throw new Error('The pack has too much Lua source to scan.')
      const src = dec.decode(bytes)

      // localization/<lang>.lua : data only, never definitions
      const lm = /^localization\/([^/]+)\.lua$/i.exec(path)
      if (lm) {
        const lang = lm[1]!.toLowerCase() === 'default' ? 'en-us' : lm[1]!
        if (!/^[A-Za-z0-9_-]+$/.test(lang)) {
          warn(
            `Localization file ${path} has an unsupported language name and was skipped.`
          )
          continue
        }
        const t = parseReturnTable(src)
        const node = t ? luaToLoc(t, 0, { n: 0 }) : null
        if (node && !Array.isArray(node) && typeof node === 'object') {
          const list = locSources.get(lang) ?? []
          list.push(node as { [k: string]: LocNode })
          locSources.set(lang, list)
        } else warn(`No readable localization data in ${path}.`)
        continue
      }

      let n = 0
      for (const def of extractDefinitions(src)) {
        n++
        const t = def.table
        if (def.kind === 'TexturePack') {
          packs.push({
            key: getString(t, 'key'),
            textures: getStringList(t, 'textures') ?? [],
            toggles: getStringList(t, 'toggle_textures') ?? [],
          })
        } else if (def.kind === 'SMODS.Sound') {
          const p = getString(t, 'path')
          const r = getString(t, 'replace')
          const label = `sound ${getString(t, 'key') ?? `#${n}`} (${path})`
          if (!p || !r)
            skip(
              label,
              r === undefined
                ? 'adds a sound instead of replacing one (no literal `replace`)'
                : 'path or replace is not a literal'
            )
          else sounds.push({ path: p, replace: r })
        } else {
          readTexture(t, path, n)
        }
      }
    }
  } catch (e) {
    if (e instanceof LuaLimitError) throw new Error(`Rejected: ${e.message}`)
    throw e
  }

  function readTexture(t: LuaTable, file: string, n: number) {
    const key = getString(t, 'key')
    const label = `texture ${key ?? `#${n}`} (${file})`
    const set = getString(t, 'set')
    const path = getString(t, 'path')
    if (set === undefined)
      return skip(
        label,
        `\`set\` is ${isFieldUnresolved(t, 'set') ? 'not a literal' : 'missing'}`
      )
    if (path === undefined)
      return skip(
        label,
        `\`path\` is ${isFieldUnresolved(t, 'path') ? 'not a literal' : 'missing'}`
      )
    const sheet = SHEET_BY_SET.get(set)
    if (!sheet)
      return skip(
        label,
        `set "${set}" is not supported (only vanilla object sets are)`
      )
    if (t.fields.has('keys') && getStringList(t, 'keys') === null)
      return skip(label, '`keys` is not a plain list of strings')
    const keys = getStringList(t, 'keys')
    // Lua truthiness: Malverk packs in the wild write `original_sheet = 'true'`.
    if (isFieldUnresolved(t, 'original_sheet'))
      warn(
        `${label}: original_sheet is not a literal; assuming the packed layout.`
      )
    const original = isTruthy(t, 'original_sheet')
    let soulKeys = new Set<string>()
    if (t.fields.has('soul_keys')) {
      const sk = getStringList(t, 'soul_keys')
      if (sk === null) {
        if (keys && !original)
          return skip(label, '`soul_keys` is not a plain list of strings')
      } else soulKeys = new Set(sk)
    }
    if (t.fields.has('soul') || soulKeys.size > 0)
      warn(`${label}: floating soul layers are not imported.`)
    if (t.fields.has('stickers')) warn(`${label}: sticker art is not imported.`)
    textures.push({
      id: key ?? `${file}#${n}`,
      key,
      file,
      set,
      sheet,
      path,
      keys,
      original: original || !keys,
      frames: getNumber(t, 'frames'),
      px: getNumber(t, 'px'),
      py: getNumber(t, 'py'),
      soulKeys,
      loc: getTable(t, 'localization'),
    })
  }

  if (textures.length === 0 && locSources.size === 0 && sounds.length === 0)
    throw new Error(
      'This does not look like a Malverk texture pack (no AltTexture definitions were found).'
    )

  // --- order: pack lists first (list order), then the rest -----------------
  const matchTexture = (entry: string): Texture | null | 'ambiguous' => {
    const exact = textures.filter((x) => x.key === entry)
    const suffix = exact.length
      ? exact
      : textures.filter((x) => x.key && entry.endsWith(`_${x.key}`))
    return suffix.length === 1
      ? suffix[0]!
      : suffix.length === 0
        ? null
        : 'ambiguous'
  }
  const ordered: Texture[] = []
  const placed = new Set<Texture>()
  const toggled = new Set<Texture>()
  for (const p of packs) {
    for (const e of p.textures) {
      const m = matchTexture(e)
      if (m === 'ambiguous')
        warn(
          `Pack ${p.key ?? '?'}: "${e}" matches more than one texture and was ignored.`
        )
      else if (!m)
        warn(`Pack ${p.key ?? '?'}: "${e}" matches no texture in this pack.`)
      else if (!placed.has(m)) {
        placed.add(m)
        ordered.push(m)
      }
    }
    for (const e of p.toggles) {
      const m = matchTexture(e)
      if (m && m !== 'ambiguous') toggled.add(m)
    }
  }
  for (const x of toggled)
    if (!placed.has(x))
      warn(
        `Texture ${x.id} is only a toggle texture; toggles are not imported.`
      )
  for (const x of textures)
    if (!placed.has(x) && !toggled.has(x)) ordered.push(x)

  // --- layout: key -> output cell, per sheet --------------------------------
  const covered = new Map<string, Map<string, Cover>>() // sheet -> key -> cover
  const fromBySheet = new Map<string, Set<string>>()
  const customSheets: CustomSheet[] = []
  const customOwner = new Map<string, CustomSheet>()
  const usedSlugs = new Set<string>()

  for (const x of ordered) {
    const info = SHEETS[x.sheet]!
    const label = `texture ${x.key ?? x.id} (${x.file})`
    const leaf = x.path
    if (!safeLeaf(leaf)) {
      skip(label, `path "${leaf.slice(0, 60)}" is not a plain file name`)
      continue
    }
    let scale = 2
    let png = lookup(pack, `assets/2x/${leaf}`)
    if (!png) {
      scale = 1
      png = lookup(pack, `assets/1x/${leaf}`)
    }
    if (!png) {
      skip(label, `image ${leaf} was not found under assets/1x or assets/2x`)
      continue
    }

    let hdr: { w: number; h: number }
    try {
      hdr = checkPngHeader(png.bytes)
    } catch (e) {
      skip(
        label,
        `${png.path}: ${e instanceof Error ? e.message : 'invalid PNG'}`
      )
      continue
    }

    const isBlind = info.frames !== undefined
    const px = x.px ?? info.cellW
    const py = x.py ?? info.cellH
    if (px < 1 || py < 1 || !Number.isInteger(px) || !Number.isInteger(py)) {
      skip(label, '`px`/`py` are not positive whole numbers')
      continue
    }
    const cw = px * scale
    const ch = py * scale
    if (hdr.w % cw !== 0 || hdr.h % ch !== 0) {
      skip(
        label,
        `${png.path} (${hdr.w}x${hdr.h}) is not a whole number of ${cw}x${ch} cells`
      )
      continue
    }
    const columns = hdr.w / cw
    const srcRows = hdr.h / ch
    const srcFrames = isBlind
      ? Math.max(1, Math.floor(x.frames ?? info.frames!))
      : 1

    let raster: Raster
    try {
      raster = await io.decode(png.bytes)
    } catch {
      skip(label, `${png.path} could not be decoded`)
      continue
    }
    if (raster.w !== hdr.w || raster.h !== hdr.h) {
      skip(label, `${png.path} decoded to a different size than its header`)
      continue
    }
    if (px !== info.cellW || py !== info.cellH)
      warn(
        `${label}: cells are ${px}x${py}, the game's are ${info.cellW}x${info.cellH}; art was resized.`
      )
    if (isBlind && srcFrames !== info.frames)
      warn(
        `${label}: ${srcFrames} blind frames were resampled to ${info.frames}.`
      )

    // Resolve a key to the vanilla sheet that owns it. A key not on this
    // texture's own sheet may still be on one that shares its atlas: tarots,
    // planets and spectrals are one image in the game, and Malverk lets a
    // texture list any of them.
    const crossed = new Set<string>()
    const find = (k: string): { sheet: string; cell: [number, number] } | null => {
      const own = info.cells[k]
      if (own) return { sheet: x.sheet, cell: own }
      if (CONSUMABLE_SHEETS.includes(x.sheet))
        for (const s of CONSUMABLE_SHEETS) {
          const c = SHEETS[s]!.cells[k]
          if (c) {
            crossed.add(s)
            return { sheet: s, cell: c }
          }
        }
      return null
    }
    const customOk =
      !x.original && CUSTOM_SETS.has(x.set) && px <= 256 && py <= 256

    // which keys, and where each one's source cell is
    const targets: {
      key: string
      sx: number
      sy: number
      sheet: string // output vanilla sheet; '' for a custom-sheet key
    }[] = []
    if (x.original) {
      const list = x.keys ?? Object.keys(info.cells)
      for (const k of list) {
        const hit = find(k)
        if (!hit) {
          warn(
            `${label}: "${k}" is not a vanilla ${x.set} (a mod object needs a packed layout to be imported) and was skipped.`
          )
          continue
        }
        targets.push({ key: k, sx: hit.cell[0], sy: hit.cell[1], sheet: hit.sheet })
      }
    } else {
      const list = x.keys!
      let souls = 0
      list.forEach((k, i) => {
        const index = isBlind ? i : i + souls
        if (x.soulKeys.has(k)) souls++
        const sx = isBlind ? 0 : index % columns
        const sy = isBlind ? index : Math.floor(index / columns)
        const hit = find(k)
        if (hit) {
          targets.push({ key: k, sx, sy, sheet: hit.sheet })
        } else if (customOk) {
          targets.push({ key: k, sx, sy, sheet: '' })
        } else {
          warn(`${label}: "${k}" is not a known ${x.set} and was skipped.`)
        }
      })
    }
    for (const s of crossed)
      warn(
        `${label}: some keys belong to the ${SHEETS[s]!.set} sheet and were imported there.`
      )

    let custom: CustomSheet | null = null
    for (const tg of targets) {
      const tgInfo = tg.sheet ? SHEETS[tg.sheet]! : info
      const outW = tg.sheet ? tgInfo.cellW * 2 : px * 2
      const outH = tg.sheet ? tgInfo.cellH * 2 : py * 2
      const sheetCovers = covered.get(tg.sheet) ?? new Map<string, Cover>()
      const frames: Raster[] = []
      let any = false
      const frameCount = isBlind ? info.frames! : 1
      let inside = true
      for (let f = 0; f < frameCount; f++) {
        const sf = isBlind
          ? Math.min(srcFrames - 1, Math.floor((f * srcFrames) / frameCount))
          : 0
        const cx = tg.sx + sf
        const cy = tg.sy
        if (cx >= columns || cy >= srcRows) {
          inside = false
          break
        }
        if (hasAlpha(raster, cx * cw, cy * ch, cw, ch)) any = true
        const cell = newRaster(outW, outH)
        blitNearest(raster, cx * cw, cy * ch, cw, ch, cell, 0, 0, outW, outH)
        frames.push(cell)
      }
      if (!inside) {
        warn(
          `${label}: the cell for ${tg.key} lies outside ${png.path} and was skipped.`
        )
        continue
      }
      if (!any) continue // transparent = not covered, keep vanilla
      if (!tg.sheet) {
        // A mod object: it goes into this texture's own custom sheet. A later
        // texture covering the same key wins, so drop it from an earlier sheet.
        if (!custom) {
          custom = {
            slug: customSlug(x.key ?? x.id, usedSlugs),
            set: x.set,
            px,
            py,
            from: png.path,
            entries: [],
          }
          customSheets.push(custom)
        }
        const prev = customOwner.get(tg.key)
        if (prev) prev.entries = prev.entries.filter((e) => e.key !== tg.key)
        custom.entries.push({ key: tg.key, cell: frames[0]! })
        customOwner.set(tg.key, custom)
        continue
      }
      sheetCovers.set(tg.key, { frames, from: png.path })
      covered.set(tg.sheet, sheetCovers)
      const set = fromBySheet.get(tg.sheet) ?? new Set<string>()
      set.add(png.path)
      fromBySheet.set(tg.sheet, set)
    }
  }

  // --- write sheets -----------------------------------------------------------
  const reskinSheets: Record<string, { keys: string[] }> = {}
  for (const [sheet, info] of Object.entries(SHEETS)) {
    const covers = covered.get(sheet)
    if (!covers || covers.size === 0) continue
    const big = newRaster(
      info.cols * info.cellW * 2,
      info.rows * info.cellH * 2
    )
    const keys: string[] = []
    for (const k of Object.keys(info.cells)) {
      const c = covers.get(k)
      if (!c) continue
      const [cx, cy] = info.cells[k]!
      c.frames.forEach((fr, f) => {
        const dx = (cx + f) * info.cellW * 2
        const dy = cy * info.cellH * 2
        for (let y = 0; y < fr.h; y++)
          big.data.set(
            fr.data.subarray(y * fr.w * 4, (y + 1) * fr.w * 4),
            ((dy + y) * big.w + dx) * 4
          )
      })
      keys.push(k)
    }
    out.set(`assets/2x/${sheet}.png`, await io.encode(big))
    out.set(`assets/1x/${sheet}.png`, await io.encode(halve(big)))
    reskinSheets[sheet] = { keys }
    report.imported.push({
      sheet,
      objects: keys.length,
      from: [...(fromBySheet.get(sheet) ?? [])].join(', '),
    })
  }

  // Custom sheets: art for objects that are not on a vanilla sheet, packed in
  // key order (key i = cell i), declared under "custom" in reskin.json.
  const customJson: Record<
    string,
    { set: string; keys: string[]; px: number; py: number }
  > = {}
  for (const cs of customSheets) {
    if (cs.entries.length === 0) continue
    const cols = Math.min(cs.entries.length, CUSTOM_COLUMNS)
    const rows = Math.ceil(cs.entries.length / CUSTOM_COLUMNS)
    const cw = cs.px * 2
    const ch = cs.py * 2
    const big = newRaster(cols * cw, rows * ch)
    cs.entries.forEach((e, i) => {
      const dx = (i % cols) * cw
      const dy = Math.floor(i / cols) * ch
      for (let y = 0; y < e.cell.h; y++)
        big.data.set(
          e.cell.data.subarray(y * e.cell.w * 4, (y + 1) * e.cell.w * 4),
          ((dy + y) * big.w + dx) * 4
        )
    })
    out.set(`assets/2x/custom_${cs.slug}.png`, await io.encode(big))
    out.set(`assets/1x/custom_${cs.slug}.png`, await io.encode(halve(big)))
    customJson[cs.slug] = {
      set: cs.set,
      keys: cs.entries.map((e) => e.key),
      px: cs.px,
      py: cs.py,
    }
    report.imported.push({
      sheet: `custom_${cs.slug}`,
      objects: cs.entries.length,
      from: cs.from,
    })
  }

  if (Object.keys(reskinSheets).length > 0 || Object.keys(customJson).length > 0)
    out.set(
      'reskin.json',
      enc.encode(
        `${JSON.stringify(
          {
            version: 1,
            sheets: reskinSheets,
            ...(Object.keys(customJson).length > 0 ? { custom: customJson } : {}),
          },
          null,
          1
        )}\n`
      )
    )

  // --- localization ------------------------------------------------------------
  for (const x of ordered) {
    if (!x.loc) continue
    const entries: { [k: string]: LocNode } = {}
    for (const [k, v] of x.loc.fields) {
      if (FORBIDDEN.has(k) || k.includes('.') || !v || typeof v !== 'object')
        continue
      const n = luaToLoc(v, 0, { n: 0 })
      if (n && !Array.isArray(n)) {
        const o = n as { [k: string]: LocNode }
        const entry: { [k: string]: LocNode } = {}
        if (o.name !== undefined) entry.name = o.name
        if (o.text !== undefined) entry.text = o.text
        if (Object.keys(entry).length > 0) entries[k] = entry
      }
    }
    if (Object.keys(entries).length === 0) continue
    const list = locSources.get('en-us') ?? []
    list.push({ descriptions: { [LOC_SET[x.set] ?? x.set]: entries } })
    locSources.set('en-us', list)
  }
  for (const [lang, list] of locSources) {
    const merged: { [k: string]: LocNode } = {}
    for (const t of list) mergeLoc(merged, t)
    dropMalverkUiText(merged)
    if (Object.keys(merged).length === 0) continue
    const text = `${JSON.stringify(merged, null, 1)}\n`
    if (enc.encode(text).length > MAX_JSON) {
      skip(`localization ${lang}`, 'larger than the 1 MiB limit')
      continue
    }
    out.set(`localization/${lang}.json`, enc.encode(text))
    report.localization.push(lang)
  }

  // --- sounds --------------------------------------------------------------------
  for (const s of sounds) {
    const label = `sound ${s.replace}`
    if (!/^[A-Za-z0-9_-]+$/.test(s.replace)) {
      skip(label, 'replacement key is not a plain sound name')
      continue
    }
    if (!safeLeaf(s.path)) {
      skip(label, `path "${s.path.slice(0, 60)}" is not a plain file name`)
      continue
    }
    const f = lookup(pack, `assets/sounds/${s.path}`)
    if (!f) {
      skip(label, `${s.path} was not found under assets/sounds`)
      continue
    }
    if (
      f.bytes.length > MAX_OGG_BYTES ||
      dec.decode(f.bytes.subarray(0, 4)) !== 'OggS'
    ) {
      skip(label, `${s.path} is not a valid Ogg file within the size limit`)
      continue
    }
    out.set(`assets/sounds/${s.replace}.ogg`, f.bytes)
    report.sounds++
  }

  const suggested = (pack.name ?? fallbackName)
    .replace(/[^A-Za-z0-9 _.-]+/g, '_')
    .trim()
    .slice(0, 64)
  return { files: out, report, suggestedName: suggested || 'Malverk pack' }
}
