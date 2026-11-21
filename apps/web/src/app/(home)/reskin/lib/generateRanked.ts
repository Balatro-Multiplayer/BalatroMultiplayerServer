// Build a ReskinStudioRanked user-assets bundle (see that repo's FORMAT.md) in
// the browser. Unlike generatePack() this emits NO mod: just vanilla-layout
// sheets (each edited object's art placed at its vanilla atlas cell, so the
// PNG has exactly the vanilla dimensions), a reskin.json restricting each
// sheet to the edited objects, and data-only localization JSON. The launcher
// imports the zip as a pack; the Ranked-approved mod loads it at runtime.
//
// Keep SHEETS in sync with FORMAT.md, the launcher's reskinfolder.cpp and the
// mod's main.lua: the launcher rejects any PNG whose size differs from vanilla.

import { posFor } from './atlasOverrides'
import { composeAtlas, type PlacedCell } from './image'
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

const LANG = /^[A-Za-z0-9_-]+$/

export async function generateRankedBundle(
  project: ProjectState,
  catalog: Catalog
): Promise<{ bytes: Uint8Array; fileName: string; warnings: string[] }> {
  const entries: ZipEntry[] = []
  const warnings: string[] = []
  const sheetCfg: Record<string, { keys: string[] }> = {}
  const skipped = { soul: 0, shader: 0, gif: 0 }

  for (const cat of catalog.spriteCategories) {
    const spec = RANKED_SHEETS[cat.id]
    if (!spec) continue
    const cells: PlacedCell[] = []
    const keys: string[] = []

    for (const o of catalog.spriteObjects[cat.id] ?? []) {
      const edit = project.objects[objId(cat.id, o.key)]
      if (!edit || !edit.sprites.some(Boolean)) continue
      const pos = posFor(cat.id, o)
      if (!pos) {
        warnings.push(`${o.name} (${o.key}) has no known atlas position and was skipped.`)
        continue
      }
      if (edit.soul) skipped.soul++
      if (edit.shader) skipped.shader++

      if (cat.frames > 1) {
        // Animated (blinds): one frame per column along the object's row.
        for (let f = 0; f < cat.frames; f++) {
          const dataUrl = edit.sprites[f] ?? edit.sprites[edit.sprites.length - 1]
          if (dataUrl) cells.push({ col: f, row: pos.y, dataUrl })
        }
      } else {
        if (edit.sprites.length > 1) skipped.gif++
        cells.push({ col: pos.x, row: pos.y, dataUrl: edit.sprites[0]! })
      }
      keys.push(o.key)
    }
    if (keys.length === 0) continue

    for (const scale of [1, 2] as const) {
      entries.push({
        name: `assets/${scale}x/${spec.file}.png`,
        data: await composeAtlas({
          cols: spec.cols,
          rows: spec.rows,
          px: cat.px,
          py: cat.py,
          scale,
          cells,
        }),
      })
    }
    sheetCfg[spec.file] = { keys }
  }

  // --- localization: plain nested JSON (the mod merges it as data) -----------
  for (const [lang, edits] of Object.entries(project.loc)) {
    if (!edits || Object.keys(edits).length === 0) continue
    if (!LANG.test(lang)) {
      warnings.push(`Language "${lang}" has an unsupported name and was skipped.`)
      continue
    }
    entries.push({
      name: `localization/${lang}.json`,
      data: zipText(JSON.stringify(nestEdits(edits), null, 2) + '\n'),
    })
  }

  if (entries.length === 0) {
    throw new Error('Nothing to export yet: add at least one sprite or text edit.')
  }

  if (Object.keys(sheetCfg).length > 0) {
    entries.push({
      name: 'reskin.json',
      data: zipText(JSON.stringify({ version: 1, sheets: sheetCfg }, null, 2) + '\n'),
    })
  }

  // --- things the Ranked format can't carry yet -------------------------------
  if (skipped.soul > 0)
    warnings.push(`${skipped.soul} soul overlay(s) were left out (not supported in Ranked bundles).`)
  if (skipped.shader > 0)
    warnings.push(`${skipped.shader} default shader(s) were left out (not supported in Ranked bundles).`)
  if (skipped.gif > 0)
    warnings.push(`${skipped.gif} animated GIF(s) were exported as their first frame only.`)
  const sheetEdits =
    (project.deckSkins?.length ?? 0) > 0 ||
    Object.values(project.sheets).some((s) => Object.keys(s).length > 0)
  if (sheetEdits)
    warnings.push('Playing card, chip and shop sign sheets were left out (not supported in Ranked bundles).')
  if (project.options.icon) warnings.push('The mod-list icon was left out (the bundle is not a mod).')

  const safeName =
    (project.options.displayName || 'Reskin')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Reskin'
  return { bytes: createZip(entries), fileName: `${safeName}-ranked.zip`, warnings }
}
