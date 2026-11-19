// Conformance tests for the Malverk importer (MALVERK_IMPORT.md section 11).
// Run: bun test scripts/reskin   (from apps/web)
import { describe, expect, test } from 'bun:test'
import zlib from 'node:zlib'
import positions from '../../src/app/(home)/reskin/data/positions.json'
import {
  importMalverkPack,
  type Raster,
  type RasterIO,
} from '../../src/app/(home)/reskin/lib/importMalverk'

// ---- tiny PNG codec (filter 0 out; all filters in) ---------------------------
function crc(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
function encodePng(r: Raster): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(r.w, 0)
  ihdr.writeUInt32BE(r.h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = r.w * 4 + 1
  const raw = Buffer.alloc(stride * r.h)
  for (let y = 0; y < r.h; y++)
    Buffer.from(r.data.buffer, r.data.byteOffset + y * r.w * 4, r.w * 4).copy(
      raw,
      y * stride + 1
    )
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}
function decodePng(b: Uint8Array): Raster {
  const buf = Buffer.from(b)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const idat: Buffer[] = []
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === 'IDAT')
      idat.push(buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const out = new Uint8ClampedArray(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!
      const a = i >= 4 ? out[y * stride + i - 4]! : 0
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0
      const ul = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4]! : 0
      const pa = Math.abs(up - ul)
      const pb = Math.abs(a - ul)
      const pc = Math.abs(a + up - 2 * ul)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? up : ul
      const pred =
        f === 0
          ? 0
          : f === 1
            ? a
            : f === 2
              ? up
              : f === 3
                ? (a + up) >> 1
                : paeth
      out[y * stride + i] = (x + pred) & 255
    }
  }
  return { w, h, data: out }
}
const io: RasterIO = {
  decode: async (b) => decodePng(b),
  encode: async (r) => encodePng(r),
}

// ---- helpers -------------------------------------------------------------------
type Color = [number, number, number, number]
type Fill = { x: number; y: number; w: number; h: number; c: Color }
function sheet(w: number, h: number, fills: Fill[]): Uint8Array {
  const r: Raster = { w, h, data: new Uint8ClampedArray(w * h * 4) }
  for (const f of fills)
    for (let y = f.y; y < f.y + f.h; y++)
      for (let x = f.x; x < f.x + f.w; x++) r.data.set(f.c, (y * w + x) * 4)
  return encodePng(r)
}
const cell = (
  cx: number,
  cy: number,
  pw: number,
  ph: number,
  c: Color
): Fill => ({
  x: cx * pw,
  y: cy * ph,
  w: pw,
  h: ph,
  c,
})
const text = (s: string) => new TextEncoder().encode(s)
const RED: Color = [255, 0, 0, 255]
const GREEN: Color = [0, 255, 0, 255]
const BLUE: Color = [0, 0, 255, 255]
const CLEAR = [0, 0, 0, 0]
type SheetInfo = {
  cellW: number
  cellH: number
  cells: Record<string, number[]>
}
const S = positions.sheets as unknown as Record<string, SheetInfo>

const MANIFEST = text(
  JSON.stringify({ id: 'p', name: 'My Pack', main_file: 'main.lua' })
)
function pixel(r: Raster, x: number, y: number): number[] {
  const o = (y * r.w + x) * 4
  return [...r.data.subarray(o, o + 4)]
}
function outSheet(
  files: Map<string, Uint8Array>,
  scale: 1 | 2,
  name: string
): Raster {
  const b = files.get(`assets/${scale}x/${name}.png`)
  if (!b) throw new Error(`missing assets/${scale}x/${name}.png`)
  return decodePng(b)
}
function cellPx(
  files: Map<string, Uint8Array>,
  sheetName: string,
  key: string,
  scale: 1 | 2 = 1
): number[] {
  const s = S[sheetName]!
  const [cx, cy] = s.cells[key]!
  return pixel(
    outSheet(files, scale, sheetName),
    cx! * s.cellW * scale + 3,
    cy! * s.cellH * scale + 3
  )
}
const keysOf = (files: Map<string, Uint8Array>, sheetName: string): string[] =>
  JSON.parse(new TextDecoder().decode(files.get('reskin.json')!)).sheets[
    sheetName
  ].keys

function pack(
  extra: Record<string, Uint8Array>,
  lua: string
): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['manifest.json', MANIFEST],
    ['main.lua', text(lua)],
    ...Object.entries(extra),
  ])
}
const one = (c: Color = RED) => sheet(71, 95, [cell(0, 0, 71, 95, c)])

describe('malverk importer', () => {
  test('1. case A full vanilla layout, no keys', async () => {
    const png = sheet(710, 1520, [
      cell(0, 0, 71, 95, RED),
      cell(4, 0, 71, 95, GREEN),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': png },
        `AltTexture({ key='a', set='Joker', path='j.png' })`
      ),
      io
    )
    expect(r.suggestedName).toBe('My Pack')
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(RED)
    expect(cellPx(r.files, 'jokers', 'j_mad')).toEqual(GREEN)
    // j_wee shares Jimbo's cell in game.lua, so it is covered too; transparent cells are not
    expect(keysOf(r.files, 'jokers')).toEqual(['j_joker', 'j_mad', 'j_wee'])
    expect(outSheet(r.files, 1, 'jokers').w).toBe(710)
    expect(outSheet(r.files, 2, 'jokers').w).toBe(1420)
    expect(cellPx(r.files, 'jokers', 'j_joker', 2)).toEqual(RED)
  })

  test('2. case A with keys', async () => {
    const png = sheet(710, 1520, [
      cell(0, 0, 71, 95, RED),
      cell(4, 0, 71, 95, GREEN),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': png },
        `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_mad'}, original_sheet=true }`
      ),
      io
    )
    expect(keysOf(r.files, 'jokers')).toEqual(['j_mad'])
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(CLEAR)
  })

  test('2b. original_sheet uses Lua truthiness (a string counts)', async () => {
    // Friends of BalatrOwen writes original_sheet = 'true' (a string).
    for (const flag of [`'true'`, `1`]) {
      const png = sheet(710, 1520, [
        cell(0, 0, 71, 95, RED),
        cell(4, 0, 71, 95, GREEN),
      ])
      const r = await importMalverkPack(
        pack(
          { 'assets/1x/j.png': png },
          `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_mad'}, original_sheet=${flag} }`
        ),
        io
      )
      expect(cellPx(r.files, 'jokers', 'j_mad')).toEqual(GREEN)
    }
    // false / nil keep the packed layout: the first cell goes to the first key.
    for (const flag of [`false`, `nil`]) {
      const png = sheet(213, 95, [cell(0, 0, 71, 95, RED)])
      const r = await importMalverkPack(
        pack(
          { 'assets/1x/j.png': png },
          `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_mad'}, original_sheet=${flag} }`
        ),
        io
      )
      expect(cellPx(r.files, 'jokers', 'j_mad')).toEqual(RED)
    }
  })

  test('3. case B packed', async () => {
    const png = sheet(213, 190, [
      cell(0, 0, 71, 95, RED),
      cell(1, 0, 71, 95, GREEN),
      cell(2, 0, 71, 95, BLUE),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': png },
        `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker','j_mad','j_greedy_joker'} }`
      ),
      io
    )
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(RED)
    expect(cellPx(r.files, 'jokers', 'j_mad')).toEqual(GREEN)
    expect(cellPx(r.files, 'jokers', 'j_greedy_joker')).toEqual(BLUE)
  })

  test('4. case B soul_keys shifts later cells', async () => {
    // cell0 = j_joker, cell1 = its soul layer (ignored), cell2 = j_mad
    const png = sheet(213, 190, [
      cell(0, 0, 71, 95, BLUE),
      cell(1, 0, 71, 95, RED),
      cell(2, 0, 71, 95, GREEN),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': png },
        `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker','j_mad'}, soul_keys={'j_joker'} }`
      ),
      io
    )
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(BLUE)
    expect(cellPx(r.files, 'jokers', 'j_mad')).toEqual(GREEN)
    expect(r.report.warnings.some((w) => /soul/i.test(w))).toBe(true)
  })

  test('5/6. later texture wins; toggle textures ignored', async () => {
    const lua = `
      AltTexture{ key='a', set='Joker', path='a.png', keys={'j_joker'} }
      AltTexture{ key='b', set='Joker', path='b.png', keys={'j_joker'} }
      AltTexture{ key='c', set='Joker', path='c.png', keys={'j_joker'} }
      TexturePack{ key='tp', textures={'x_a','x_b'}, toggle_textures={'x_c'} }`
    const r = await importMalverkPack(
      pack(
        {
          'assets/1x/a.png': one(RED),
          'assets/1x/b.png': one(GREEN),
          'assets/1x/c.png': one(BLUE),
        },
        lua
      ),
      io
    )
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(GREEN)
  })

  test('7. 1x only and 2x only', async () => {
    const two = sheet(142, 190, [cell(0, 0, 142, 190, GREEN)])
    const lua = `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker'} }`
    const r1 = await importMalverkPack(
      pack({ 'assets/1x/j.png': one(RED) }, lua),
      io
    )
    const r2 = await importMalverkPack(
      pack({ 'assets/2x/j.png': two }, lua),
      io
    )
    expect(cellPx(r1.files, 'jokers', 'j_joker', 2)).toEqual(RED)
    expect(cellPx(r2.files, 'jokers', 'j_joker', 1)).toEqual(GREEN)
  })

  test('8. non-standard px/py is resized with a warning', async () => {
    const png = sheet(35, 47, [cell(0, 0, 35, 47, RED)])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': png },
        `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker'}, px=35, py=47 }`
      ),
      io
    )
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(RED)
    expect(r.report.warnings.some((w) => /resized/.test(w))).toBe(true)
  })

  test('9/10. blind frames resampled; tag and stake', async () => {
    const blind = sheet(34 * 3, 34, [
      cell(0, 0, 34, 34, RED),
      cell(1, 0, 34, 34, GREEN),
      cell(2, 0, 34, 34, BLUE),
    ])
    const tag = sheet(34, 34, [cell(0, 0, 34, 34, RED)])
    const lua = `
      AltTexture{ key='b', set='Blind', path='b.png', keys={'bl_small'}, frames=3 }
      AltTexture{ key='t', set='Tag', path='t.png', keys={'tag_uncommon'} }
      AltTexture{ key='s', set='Stake', path='s.png', keys={'stake_red'} }`
    const r = await importMalverkPack(
      pack(
        {
          'assets/1x/b.png': blind,
          'assets/1x/t.png': tag,
          'assets/1x/s.png': sheet(29, 29, [cell(0, 0, 29, 29, RED)]),
        },
        lua
      ),
      io
    )
    const [bx, by] = S.blinds!.cells.bl_small!
    const sh = outSheet(r.files, 1, 'blinds')
    expect(pixel(sh, bx! * 34 + 3, by! * 34 + 3)).toEqual(RED)
    expect(pixel(sh, (bx! + 20) * 34 + 3, by! * 34 + 3)).toEqual(BLUE)
    expect(r.report.warnings.some((w) => /resampled/.test(w))).toBe(true)
    expect(cellPx(r.files, 'tags', 'tag_uncommon')).toEqual(RED)
    expect(keysOf(r.files, 'stakes')).toEqual(['stake_red'])
  })

  test('12. localization: Lua file, table, dropped UI subtree, hostile values', async () => {
    const longStr = 'x'.repeat(4001)
    const files = pack(
      {
        'assets/1x/j.png': one(),
        'localization/default.lua': text(`return { descriptions = {
          Joker = { j_joker = { name = "Clown", text = { "+4 Mult", "line 2" } },
                    ["__proto__"] = { name = "x" }, big = { name = "${longStr}" } },
          alt_texture = { a = { name = "ui" } }, texture_packs = { p = { name = "ui" } } },
          misc = { v = os.execute("rm -rf /") } }`),
      },
      `AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker'},
        localization = { j_greedy_joker = { name='Greedy', text={'hi'}, badge='b' } } }`
    )
    const r = await importMalverkPack(files, io)
    const loc = JSON.parse(
      new TextDecoder().decode(r.files.get('localization/en-us.json')!)
    )
    expect(loc.descriptions.Joker.j_joker.name).toBe('Clown')
    expect(loc.descriptions.Joker.j_joker.text).toEqual(['+4 Mult', 'line 2'])
    expect(loc.descriptions.Joker.j_greedy_joker).toEqual({
      name: 'Greedy',
      text: ['hi'],
    })
    expect(loc.descriptions.alt_texture).toBeUndefined()
    expect(loc.descriptions.texture_packs).toBeUndefined()
    expect(Object.hasOwn(loc.descriptions.Joker, '__proto__')).toBe(false)
    expect(loc.descriptions.Joker.big).toBeUndefined()
    expect(loc.misc).toBeUndefined()
  })

  test('13. sound with replace', async () => {
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3])
    const lua = `
      SMODS.Sound{ key='s', path='boop.ogg', replace='chips1' }
      SMODS.Sound{ key='n', path='boop.ogg' }
      AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker'} }`
    const r = await importMalverkPack(
      pack({ 'assets/sounds/boop.ogg': ogg, 'assets/1x/j.png': one() }, lua),
      io
    )
    expect(r.files.get('assets/sounds/chips1.ogg')).toEqual(ogg)
    expect(r.report.sounds).toBe(1)
    expect(r.report.skipped.length).toBe(1)
  })

  test('14. unresolved set/path/keys are skipped with the field named', async () => {
    const lua = `
      local n = "x"
      AltTexture{ key='a', set=n, path='j.png', keys={'j_joker'} }
      AltTexture{ key='b', set='Joker', path='j' .. n .. '.png', keys={'j_joker'} }
      AltTexture{ key='c', set='Joker', path='j.png', keys={'j_joker', n} }
      AltTexture{ key='ok', set='Joker', path='j.png', keys={'j_joker'} }`
    const r = await importMalverkPack(
      pack({ 'assets/1x/j.png': one() }, lua),
      io
    )
    const reasons = r.report.skipped.map((s) => s.reason)
    expect(reasons.some((x) => x.includes('`set`'))).toBe(true)
    expect(reasons.some((x) => x.includes('`path`'))).toBe(true)
    expect(reasons.some((x) => x.includes('`keys`'))).toBe(true)
    expect(cellPx(r.files, 'jokers', 'j_joker')).toEqual(RED)
  })

  test('15. hostile inputs', async () => {
    // IHDR claims 60000x60000: skipped from the header alone, never decoded
    const fake = new Uint8Array(33)
    fake.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52,
    ])
    new DataView(fake.buffer).setUint32(16, 60000)
    new DataView(fake.buffer).setUint32(20, 60000)
    let decodes = 0
    const spy: RasterIO = {
      decode: async (b) => {
        decodes++
        return io.decode(b)
      },
      encode: io.encode,
    }
    const lua = `
      AltTexture{ key='a', set='Joker', path='j.png', keys={'j_joker'} }
      AltTexture{ key='b', set='Joker', path='k.png', keys={'j_mad'} }`
    const r = await importMalverkPack(
      pack({ 'assets/1x/j.png': fake, 'assets/1x/k.png': one() }, lua),
      spy
    )
    expect(decodes).toBe(1)
    expect(r.report.skipped.some((s) => /exceed/.test(s.reason))).toBe(true)

    await expect(
      importMalverkPack(new Map([['../evil.lua', text('x')]]), io)
    ).rejects.toThrow(/Unsafe/)
    await expect(
      importMalverkPack(
        pack({}, `AltTexture{ a=${'{'.repeat(40)}${'}'.repeat(40)} }`),
        io
      )
    ).rejects.toThrow(/nested/)
    await expect(
      importMalverkPack(pack({}, `print("hi")`), io)
    ).rejects.toThrow(/Malverk/)

    const r2 = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': one() },
        `AltTexture{ key='a', set='Joker', path='../j.png', keys={'j_joker'} }
         AltTexture{ key='b', set='Joker', path='j.png', keys={'j_joker'} }`
      ),
      io
    )
    expect(
      r2.report.skipped.some((s) => /plain file name/.test(s.reason))
    ).toBe(true)
  })

  test('14. a planet listed in a Tarot texture goes to the planets sheet', async () => {
    // Friends of BalatrOwen lists c_venus under set 'Tarot'; Malverk accepts it
    // because tarots, planets and spectrals are one atlas.
    const png = sheet(710, 570, [
      cell(...(S.tarots!.cells.c_fool as [number, number]), 71, 95, RED),
      cell(...(S.planets!.cells.c_venus as [number, number]), 71, 95, GREEN),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/t.png': png },
        `AltTexture{ key='a', set='Tarot', path='t.png', original_sheet='true', keys={'c_fool','c_venus'} }`
      ),
      io
    )
    expect(keysOf(r.files, 'tarots')).toEqual(['c_fool'])
    expect(keysOf(r.files, 'planets')).toEqual(['c_venus'])
    expect(cellPx(r.files, 'planets', 'c_venus')).toEqual(GREEN)
    expect(r.report.skipped).toEqual([])
    expect(r.report.warnings.join(' ')).not.toMatch(/not a known/)
  })

  test('15. a packed texture of mod objects becomes a custom sheet', async () => {
    const png = sheet(142, 95, [
      cell(0, 0, 71, 95, RED),
      cell(1, 0, 71, 95, GREEN),
    ])
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/m.png': png },
        `AltTexture{ key='Bacon Ticket', set='Joker', path='m.png', keys={'j_mp_ticket','j_mp_other','j_mad'} }`
      ),
      io
    )
    const cfg = JSON.parse(new TextDecoder().decode(r.files.get('reskin.json')!))
    // j_mad is a vanilla joker (cell 2 of the source: blank, so not covered);
    // the two mod keys go to a packed custom sheet in key order.
    expect(cfg.custom.bacon_ticket).toEqual({
      set: 'Joker',
      keys: ['j_mp_ticket', 'j_mp_other'],
      px: 71,
      py: 95,
    })
    const one1x = outSheet(r.files, 1, 'custom_bacon_ticket')
    expect([one1x.w, one1x.h]).toEqual([142, 95])
    expect(pixel(one1x, 3, 3)).toEqual(RED)
    expect(pixel(one1x, 71 + 3, 3)).toEqual(GREEN)
    expect(outSheet(r.files, 2, 'custom_bacon_ticket').w).toBe(284)
    expect(r.report.imported.map((i) => i.sheet)).toContain('custom_bacon_ticket')
  })

  test('16. a mod object under original_sheet cannot be placed and is skipped', async () => {
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/j.png': sheet(710, 1520, [cell(0, 0, 71, 95, RED)]) },
        `AltTexture{ key='a', set='Joker', path='j.png', original_sheet=true, keys={'j_joker','j_mp_ticket'} }`
      ),
      io
    )
    expect(keysOf(r.files, 'jokers')).toEqual(['j_joker'])
    expect(r.files.has('assets/1x/custom_a.png')).toBe(false)
    expect(r.report.warnings.join(' ')).toMatch(/j_mp_ticket.*not a vanilla/)
  })

  test('17. a later texture wins the same mod key', async () => {
    const r = await importMalverkPack(
      pack(
        { 'assets/1x/a.png': one(RED), 'assets/1x/b.png': one(GREEN) },
        `AltTexture{ key='first', set='Joker', path='a.png', keys={'j_mp_x'} }
         AltTexture{ key='second', set='Joker', path='b.png', keys={'j_mp_x'} }`
      ),
      io
    )
    const cfg = JSON.parse(new TextDecoder().decode(r.files.get('reskin.json')!))
    expect(cfg.custom.second.keys).toEqual(['j_mp_x'])
    expect(cfg.custom.first).toBeUndefined()
    expect(pixel(outSheet(r.files, 1, 'custom_second'), 3, 3)).toEqual(GREEN)
  })
})
