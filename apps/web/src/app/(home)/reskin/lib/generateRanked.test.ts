import { test } from 'bun:test'
import assert from 'node:assert/strict'
import catalogData from '../data/catalog.json'
import { generateRankedBundle } from './generateRanked'
import { type Catalog, emptyProject, type ProjectState } from './types'
import { readZip, unzipText } from './zip'

const catalog = catalogData as Catalog
const art = (tag: string) =>
  `data:image/png;base64,${Buffer.from(tag).toString('base64')}`

// A draw-call ledger, not a PNG encoder: exercises the real exporter and ZIP
// paths without a DOM. Each PNG is the JSON of its size and draw calls.
async function bundle(edit: (p: ProjectState) => void) {
  const previous = ['Image', 'document'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  )
  class TestImage {
    onload?: () => void
    value = ''
    set src(src: string) {
      this.value = src
      queueMicrotask(() => this.onload?.())
    }
  }
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: TestImage,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        const draws: unknown[] = []
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              imageSmoothingEnabled: true,
              drawImage(img: TestImage, ...args: number[]) {
                draws.push([img.value, ...args])
              },
            }
          },
          toBlob(
            this: { width: number; height: number },
            cb: (blob: Blob) => void
          ) {
            cb(
              new Blob([
                JSON.stringify({
                  width: this.width,
                  height: this.height,
                  draws,
                }),
              ])
            )
          },
        }
      },
    },
  })
  try {
    const project = emptyProject()
    edit(project)
    const result = await generateRankedBundle(project, catalog)
    const files = readZip(result.bytes)
    const json = (name: string) => JSON.parse(unzipText(files.get(name)!))
    return { files, result, json }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function firstWithSoul() {
  for (const cat of catalog.spriteCategories) {
    const o = (catalog.spriteObjects[cat.id] ?? []).find(
      (x) => x.soul && x.soulPos
    )
    if (o) return { cat, o }
  }
  throw new Error('catalog has no soul object')
}

test('card skins export as selectable deck skins, not a whole-sheet replacement', async () => {
  const { files, json, result } = await bundle((p) => {
    p.options.displayName = 'Bug Cards'
    p.deckSkins = [
      { id: 'abc-123', name: 'Bugs', low: art('low'), high: art('high') },
      { id: 'only_low', name: 'Low only', low: art('low2') },
      { id: 'empty', name: 'Nothing' },
    ]
  })
  const cfg = json('reskin.json')
  assert.deepEqual(Object.keys(cfg.deckSkins), ['abc_123', 'only_low'])
  assert.equal(cfg.deckSkins.abc_123.name, 'Bugs')
  assert.ok(!files.has('assets/1x/cards.png'))
  for (const name of [
    'assets/1x/deckskin_abc_123_lc.png',
    'assets/1x/deckskin_abc_123_hc.png',
    'assets/2x/deckskin_abc_123_lc.png',
    'assets/1x/deckskin_only_low_lc.png',
    'assets/2x/deckskin_only_low_lc.png',
  ]) {
    assert.ok(files.has(name), name)
  }
  assert.ok(!files.has('assets/1x/deckskin_only_low_hc.png'))
  const lc = json('assets/1x/deckskin_abc_123_lc.png')
  assert.deepEqual([lc.width, lc.height], [923, 380])
  assert.deepEqual(json('assets/2x/deckskin_abc_123_hc.png').width, 1846)
  assert.ok(result.warnings.some((w) => w.includes('has no image')))
  assert.ok(!result.warnings.some((w) => w.includes('not supported')))
})

test('chips and the shop sign export as sheets', async () => {
  const chips = catalog.spriteSheets.find((s) => s.id === 'chips')!
  const { files, json } = await bundle((p) => {
    p.sheets.chips = { 0: art('white'), 3: art('blue') }
    p.sheets.shop_sign = { 0: art('s0'), 2: art('s2') }
  })
  const cfg = json('reskin.json')
  assert.deepEqual(cfg.sheets.stakes.keys, [
    chips.cells[0]!.key,
    chips.cells[3]!.key,
  ])
  assert.deepEqual(
    [json('assets/1x/stakes.png').width, json('assets/1x/stakes.png').height],
    [145, 58]
  )
  const sign = json('assets/1x/shopsign.png')
  assert.deepEqual([sign.width, sign.height], [452, 57])
  assert.equal(sign.draws.length, 4) // frames 1 and 3 repeat the previous edit
  assert.deepEqual(json('assets/2x/shopsign.png').width, 904)
})

test('soul layers, animations and shaders become atlases, rebinds and shaders', async () => {
  const { cat, o } = firstWithSoul()
  const tarot = catalog.spriteObjects.Tarot![0]!
  const { files, json } = await bundle((p) => {
    // Overlay-only edit: no base art, so the vanilla base cell is never exported.
    p.objects[`${cat.id}/${o.key}`] = {
      sprites: [],
      soul: art('soul'),
      shader: 'foil',
    }
    p.objects[`Tarot/${tarot.key}`] = {
      sprites: [art('f1'), art('f2'), art('f3')],
      fps: 12,
    }
  })
  const cfg = json('reskin.json')
  assert.equal(cfg.sheets, undefined) // neither object lives on a vanilla sheet
  const soulAtlas = `soul_${cat.id.toLowerCase()}`
  assert.deepEqual(cfg.atlases[soulAtlas], { px: cat.px, py: cat.py })
  assert.deepEqual(cfg.atlases.anim_1, { px: 71, py: 95, frames: 3, fps: 12 })
  assert.deepEqual(json('assets/1x/atlas_anim_1.png').width, 71 * 3)
  assert.deepEqual(json('assets/2x/atlas_anim_1.png').width, 71 * 3 * 2)
  assert.ok(files.has(`assets/1x/atlas_${soulAtlas}.png`))
  assert.deepEqual(cfg.objects, [
    {
      registry: cat.registry,
      key: o.key,
      soul_atlas: soulAtlas,
      soul_x: 0,
      soul_y: 0,
      ...(o.soulTarget === 'shared' ? { soul_shared: true } : {}),
    },
    { registry: 'P_CENTERS', key: tarot.key, atlas: 'anim_1', x: 0, y: 0 },
  ])
  assert.deepEqual(cfg.shaders, [{ key: o.key, shader: 'foil' }])
})

test('an animation and a soul layer on one object share one rebind entry', async () => {
  const { cat, o } = firstWithSoul()
  if (cat.frames > 1) return
  const { json } = await bundle((p) => {
    p.objects[`${cat.id}/${o.key}`] = {
      sprites: [art('a'), art('b')],
      soul: art('soul'),
    }
  })
  const cfg = json('reskin.json')
  assert.equal(cfg.objects.length, 1)
  assert.equal(cfg.objects[0].atlas, 'anim_1')
  assert.ok(cfg.objects[0].soul_atlas)
})

test('long animations are cut to what fits the 2048px atlas limit', async () => {
  const joker = catalog.spriteObjects.Joker![0]!
  const frames = Array.from({ length: 40 }, (_, i) => art(`f${i}`))
  const { json, result } = await bundle((p) => {
    p.objects[`Joker/${joker.key}`] = { sprites: frames }
  })
  const cfg = json('reskin.json')
  assert.equal(cfg.atlases.anim_1.frames, 28) // floor(2048 / 71)
  assert.ok(result.warnings.some((w) => w.includes('28 of 40')))
})

test('a shader alone is a valid export', async () => {
  const joker = catalog.spriteObjects.Joker![0]!
  const { files, json } = await bundle((p) => {
    p.objects[`Joker/${joker.key}`] = { sprites: [], shader: 'holo' }
  })
  assert.deepEqual([...files.keys()], ['reskin.json'])
  assert.deepEqual(json('reskin.json').shaders, [
    { key: joker.key, shader: 'holo' },
  ])
})

test('the sample pack from a user exports its seals and its deck skin', async () => {
  const sealKeys = ['Gold', 'Red', 'Blue', 'Purple']
  const { files, json, result } = await bundle((p) => {
    for (const k of sealKeys)
      p.objects[`Seal/${k}`] = { sprites: [art(`seal_${k}`)] }
    p.deckSkins = [
      {
        id: '48379dee7e70f5867242f020f860d6aa',
        name: 'Test_Deltadeck+Seals',
        low: art('lc'),
        high: art('hc'),
      },
    ]
  })
  const cfg = json('reskin.json')
  assert.deepEqual(cfg.sheets.seals.keys, sealKeys)
  assert.deepEqual(Object.keys(cfg.deckSkins), [
    '48379dee7e70f5867242f020f860d6aa',
  ])
  assert.ok(files.has('assets/1x/seals.png'))
  assert.ok(
    files.has('assets/2x/deckskin_48379dee7e70f5867242f020f860d6aa_hc.png')
  )
  assert.deepEqual(result.warnings, [])
})
