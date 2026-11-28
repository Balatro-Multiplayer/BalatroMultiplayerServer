// Build a ReskinStudioRanked user-assets bundle (see that repo's FORMAT.md) in
// the browser. Unlike generatePack() this emits NO mod: just vanilla-layout
// sheets (each edited object's art placed at its vanilla atlas cell, so the
// PNG has exactly the vanilla dimensions), deck skins, small atlases that the
// mod points single objects at (animations and soul layers), a reskin.json
// describing all of that, and data-only localization JSON. The launcher
// imports the zip as a pack; the Ranked-approved mod loads it at runtime.
//
// Keep this in sync with FORMAT.md, the launcher's reskinfolder.cpp and the
// mod's main.lua: the launcher rejects any PNG whose size differs from what
// reskin.json declares.

import { posFor } from './atlasOverrides'
import { migrateDeckSkins, skinName, validateDeckSkins } from './deckSkins'
import { composeAtlas, composeWhole, type PlacedCell } from './image'
import { nestEdits } from './luaSerialize'
import { type Catalog, objId, type ProjectState } from './types'
import { createZip, type ZipEntry, zipText } from './zip'

export interface RankedSheet {
  file: string // assets/<1x|2x>/<file>.png
  cols: number // vanilla grid, so cols*px x rows*py is the exact vanilla size
  rows: number
}

// Studio category id -> Ranked sheet. Dimensions at 1x: jokers 710x1520,
// tarots/planets/spectrals 710x570, vouchers 639x380, boosters 284x855,
// enhancers/decks/seals 497x475, tags 204x170, blinds 714x1054.
export const RANKED_SHEETS: Record<string, RankedSheet> = {
  Joker: { file: 'jokers', cols: 10, rows: 16 },
  Tarot: { file: 'tarots', cols: 10, rows: 6 },
  Planet: { file: 'planets', cols: 10, rows: 6 },
  Spectral: { file: 'spectrals', cols: 10, rows: 6 },
  Voucher: { file: 'vouchers', cols: 9, rows: 4 },
  Booster: { file: 'boosters', cols: 4, rows: 9 },
  Enhanced: { file: 'enhancers', cols: 7, rows: 5 },
  Back: { file: 'decks', cols: 7, rows: 5 },
  Seal: { file: 'seals', cols: 7, rows: 5 },
  Tag: { file: 'tags', cols: 6, rows: 5 },
  Blind: { file: 'blinds', cols: 21, rows: 31 },
}

// Sheets that are not per-object categories. Keep in sync with FORMAT.md.
//  - stakes: the stake chips, a partial sheet (reskin.json keys), via Malverk.
//  - shopsign: the shop sign animation strip (vanilla ShopSignAnimation.png).
//  - cards: the playing card faces as ONE whole sheet replacing the game's
//    default faces. The Studio exports card skins as deck skins instead, but
//    reads this file back (older bundles) as a deck skin.
export const CHIPS_FILE = 'stakes'
export const CARDS_FILE = 'cards'
export const SHOP_SIGN_FILE = 'shopsign'
export const SHOP_SIGN = { px: 113, py: 57, frames: 4 } as const

// A playing-card face sheet: 13 ranks x 4 suits of 71x95 cells.
export const CARDS_SIZE = { w: 923, h: 380 } as const

// Limits mirrored from FORMAT.md / the launcher / the mod.
export const MAX_DECK_SKINS = 16
export const MAX_ATLASES = 64
export const MAX_ATLAS_SIDE = 2048 // at 1x
export const MAX_FRAMES = 64

export const deckSkinFile = (id: string, contrast: 'lc' | 'hc') =>
  `deckskin_${id}_${contrast}`
export const atlasFile = (name: string) => `atlas_${name}`

const LANG = /^[A-Za-z0-9_-]+$/

/** A Studio deck-skin id as a Ranked id (`^[a-z0-9_]{1,40}$`), unique among `taken`. */
function rankedSkinId(id: string, taken: Set<string>): string {
  const base =
    id
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .slice(0, 36) || 'skin'
  let out = base
  for (let n = 2; taken.has(out); n++)
    out = `${base.slice(0, 36 - String(n).length)}_${n}`.slice(0, 40)
  taken.add(out)
  return out
}

interface RebindEntry {
  registry: string
  key: string
  atlas?: string
  x?: number
  y?: number
  soul_atlas?: string
  soul_x?: number
  soul_y?: number
  soul_shared?: true
}

function gridFor(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  return { cols, rows: Math.ceil(n / cols) }
}

export async function generateRankedBundle(
  project: ProjectState,
  catalog: Catalog
): Promise<{ bytes: Uint8Array; fileName: string; warnings: string[] }> {
  project = migrateDeckSkins(project)
  validateDeckSkins(project.deckSkins)
  const entries: ZipEntry[] = []
  const warnings: string[] = []
  const sheetCfg: Record<string, { keys: string[] }> = {}
  const atlasCfg: Record<
    string,
    { px: number; py: number; frames?: number; fps?: number }
  > = {}
  const rebinds = new Map<string, RebindEntry>()
  const shaders: Array<{ key: string; shader: string }> = []
  const deckSkinCfg: Record<string, { name: string }> = {}

  const rebind = (registry: string, key: string): RebindEntry => {
    const id = `${registry}/${key}`
    let entry = rebinds.get(id)
    if (!entry) {
      entry = { registry, key }
      rebinds.set(id, entry)
    }
    return entry
  }

  const pushAtlas = async (
    file: string,
    cols: number,
    rows: number,
    px: number,
    py: number,
    cells: PlacedCell[]
  ) => {
    for (const scale of [1, 2] as const) {
      entries.push({
        name: `assets/${scale}x/${file}.png`,
        data: await composeAtlas({ cols, rows, px, py, scale, cells }),
      })
    }
  }

  let animCount = 0

  for (const cat of catalog.spriteCategories) {
    const spec = RANKED_SHEETS[cat.id]
    if (!spec) continue
    const objects = catalog.spriteObjects[cat.id] ?? []
    const cells: PlacedCell[] = []
    const keys: string[] = []

    for (const o of objects) {
      const edit = project.objects[objId(cat.id, o.key)]
      if (!edit) continue
      if (edit.shader) shaders.push({ key: o.key, shader: edit.shader })
      if (!edit.sprites.some(Boolean)) continue

      // An uploaded GIF is an animation: its own frame strip, bound to the object.
      // (Blinds are always animated and live on the vanilla blinds sheet.)
      if (cat.frames <= 1 && edit.sprites.length > 1) {
        if (Object.keys(atlasCfg).length >= MAX_ATLASES) {
          warnings.push(
            `${o.name} (${o.key}): too many animations in one bundle; it was skipped.`
          )
          continue
        }
        const maxFrames = Math.min(
          MAX_FRAMES,
          Math.floor(MAX_ATLAS_SIDE / cat.px)
        )
        const frames = Math.min(edit.sprites.length, maxFrames)
        if (frames < edit.sprites.length) {
          warnings.push(
            `${o.name} (${o.key}): only the first ${frames} of ${edit.sprites.length} animation frames fit and were exported.`
          )
        }
        const name = `anim_${++animCount}`
        await pushAtlas(
          atlasFile(name),
          frames,
          1,
          cat.px,
          cat.py,
          edit.sprites
            .slice(0, frames)
            .map((dataUrl, f) => ({ col: f, row: 0, dataUrl }))
        )
        atlasCfg[name] = {
          px: cat.px,
          py: cat.py,
          frames,
          ...(edit.fps ? { fps: edit.fps } : {}),
        }
        Object.assign(rebind(cat.registry, o.key), { atlas: name, x: 0, y: 0 })
        continue
      }

      const pos = posFor(cat.id, o)
      if (!pos) {
        warnings.push(
          `${o.name} (${o.key}) has no known atlas position and was skipped.`
        )
        continue
      }
      if (cat.frames > 1) {
        // Animated (blinds): one frame per column along the object's row.
        for (let f = 0; f < cat.frames; f++) {
          const dataUrl =
            edit.sprites[f] ?? edit.sprites[edit.sprites.length - 1]
          if (dataUrl) cells.push({ col: f, row: pos.y, dataUrl })
        }
      } else {
        cells.push({ col: pos.x, row: pos.y, dataUrl: edit.sprites[0]! })
      }
      keys.push(o.key)
    }

    if (keys.length > 0) {
      await pushAtlas(spec.file, spec.cols, spec.rows, cat.px, cat.py, cells)
      sheetCfg[spec.file] = { keys }
    }

    // Floating (soul) layers: a packed grid of overlay cells per category, bound
    // to each object's soul slot. A hidden overlay reserves a transparent cell.
    // Overlay-only edits need no copy of the vanilla base.
    const souls = objects.filter((o) => {
      const e = project.objects[objId(cat.id, o.key)]
      return e && (e.soul || e.hideSoul)
    })
    if (souls.length > 0) {
      if (Object.keys(atlasCfg).length >= MAX_ATLASES) {
        warnings.push(
          `Too many atlases in one bundle: the ${cat.label} soul layers were skipped.`
        )
      } else {
        const grid = gridFor(souls.length)
        const name = `soul_${cat.id.toLowerCase()}`
        const soulCells: PlacedCell[] = []
        souls.forEach((o, i) => {
          const e = project.objects[objId(cat.id, o.key)]!
          if (e.soul && !e.hideSoul)
            soulCells.push({
              col: i % grid.cols,
              row: Math.floor(i / grid.cols),
              dataUrl: e.soul,
            })
        })
        await pushAtlas(
          atlasFile(name),
          grid.cols,
          grid.rows,
          cat.px,
          cat.py,
          soulCells
        )
        atlasCfg[name] = { px: cat.px, py: cat.py }
        souls.forEach((o, i) => {
          Object.assign(rebind(cat.registry, o.key), {
            soul_atlas: name,
            soul_x: i % grid.cols,
            soul_y: Math.floor(i / grid.cols),
            ...(o.soulTarget === 'shared'
              ? { soul_shared: true as const }
              : {}),
          })
        })
      }
    }
  }

  // --- sheets that are not per-object categories ------------------------------
  // Stake chips: a partial sheet like the object categories (keys restrict it).
  const chips = project.sheets.chips
  const chipSheet = catalog.spriteSheets.find((s) => s.id === 'chips')
  if (chips && chipSheet && Object.keys(chips).length > 0) {
    const cols = chipSheet.cols ?? 1
    const cells: PlacedCell[] = []
    const keys: string[] = []
    for (const [idxStr, dataUrl] of Object.entries(chips)) {
      const index = Number(idxStr)
      const key = chipSheet.cells[index]?.key
      if (!key) continue
      cells.push({ col: index % cols, row: Math.floor(index / cols), dataUrl })
      keys.push(key)
    }
    if (keys.length > 0) {
      await pushAtlas(
        CHIPS_FILE,
        cols,
        chipSheet.rows ?? 1,
        chipSheet.px,
        chipSheet.py,
        cells
      )
      sheetCfg[CHIPS_FILE] = { keys }
    }
  }

  // Shop sign: a strip of SHOP_SIGN.frames frames. The animation needs every
  // frame, so a missing one repeats the last edited frame.
  const sign = project.sheets.shop_sign
  if (sign && Object.keys(sign).length > 0) {
    const cells: PlacedCell[] = []
    let last: string | undefined
    for (let f = 0; f < SHOP_SIGN.frames; f++) {
      const url = sign[f] ?? last
      if (url) {
        last = url
        cells.push({ col: f, row: 0, dataUrl: url })
      }
    }
    await pushAtlas(
      SHOP_SIGN_FILE,
      SHOP_SIGN.frames,
      1,
      SHOP_SIGN.px,
      SHOP_SIGN.py,
      cells
    )
  }

  // --- playing cards: each named skin is a selectable deck skin ---------------
  // Either contrast may be omitted (the mod uses the one that exists for both).
  const takenIds = new Set<string>()
  let skinCount = 0
  for (const skin of project.deckSkins) {
    const name = skinName(skin, project.options.displayName)
    if (!skin.low && !skin.high) {
      warnings.push(`Card skin “${name}” has no image and was left out.`)
      continue
    }
    if (skinCount >= MAX_DECK_SKINS) {
      warnings.push(
        `Card skin “${name}” was left out: a bundle holds at most ${MAX_DECK_SKINS} card skins.`
      )
      continue
    }
    skinCount++
    const id = rankedSkinId(skin.id, takenIds)
    for (const [contrast, dataUrl] of [
      ['lc', skin.low],
      ['hc', skin.high],
    ] as const) {
      if (!dataUrl) continue
      for (const scale of [1, 2] as const) {
        entries.push({
          name: `assets/${scale}x/${deckSkinFile(id, contrast)}.png`,
          data: await composeWhole({
            width: CARDS_SIZE.w * scale,
            height: CARDS_SIZE.h * scale,
            dataUrl,
          }),
        })
      }
    }
    deckSkinCfg[id] = {
      name:
        [...name]
          .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
          .join('')
          .slice(0, 64) || id,
    }
  }

  // --- localization: plain nested JSON (the mod merges it as data) -----------
  for (const [lang, edits] of Object.entries(project.loc)) {
    if (!edits || Object.keys(edits).length === 0) continue
    if (!LANG.test(lang)) {
      warnings.push(
        `Language "${lang}" has an unsupported name and was skipped.`
      )
      continue
    }
    entries.push({
      name: `localization/${lang}.json`,
      data: zipText(JSON.stringify(nestEdits(edits), null, 2) + '\n'),
    })
  }

  const hasShaders = shaders.length > 0
  if (entries.length === 0 && !hasShaders) {
    throw new Error(
      'Nothing to export yet: add at least one sprite or text edit.'
    )
  }

  const config: Record<string, unknown> = { version: 1 }
  if (Object.keys(sheetCfg).length > 0) config.sheets = sheetCfg
  if (Object.keys(deckSkinCfg).length > 0) config.deckSkins = deckSkinCfg
  if (Object.keys(atlasCfg).length > 0) config.atlases = atlasCfg
  if (rebinds.size > 0) config.objects = [...rebinds.values()]
  if (hasShaders) config.shaders = shaders
  if (Object.keys(config).length > 1) {
    entries.push({
      name: 'reskin.json',
      data: zipText(JSON.stringify(config, null, 2) + '\n'),
    })
  }

  // --- things the Ranked format can't carry ------------------------------------
  if (project.options.icon)
    warnings.push('The mod-list icon was left out (the bundle is not a mod).')

  const safeName =
    (project.options.displayName || 'Reskin')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Reskin'
  return {
    bytes: createZip(entries),
    fileName: `${safeName}-ranked.zip`,
    warnings,
  }
}
