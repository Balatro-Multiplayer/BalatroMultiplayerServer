// Hardening of the Studio's ZIP reader against untrusted packs.
// Run: bun test scripts/reskin   (from apps/web)
import { describe, expect, test } from 'bun:test'
import { createZip, readZipChecked } from '../../src/app/(home)/reskin/lib/zip'

const bytes = (s: string) => new TextEncoder().encode(s)

function eocdOffset(buf: Uint8Array): number {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = buf.length - 22; i >= 0; i--)
    if (v.getUint32(i, true) === 0x06054b50) return i
  throw new Error('no EOCD')
}
function centralOffset(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
    eocdOffset(buf) + 16,
    true
  )
}

describe('readZipChecked', () => {
  test('reads a plain STORE zip', () => {
    const zip = createZip([
      { name: 'a.txt', data: bytes('hello') },
      { name: 'b/c.txt', data: bytes('world') },
    ])
    const { files } = readZipChecked(zip)
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello')
    expect(new TextDecoder().decode(files.get('b/c.txt'))).toBe('world')
  })

  test('the size limit counts bytes read, not the declared size', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('hello') }])
    // Claim a 4 GB uncompressed size; only 5 bytes are actually there.
    new DataView(zip.buffer).setUint32(
      centralOffset(zip) + 24,
      0xfffffffe,
      true
    )
    const { files } = readZipChecked(zip)
    expect(files.get('a.txt')?.length).toBe(5)
  })

  test('refuses duplicate entry names', () => {
    const zip = createZip([
      { name: 'a.txt', data: bytes('first') },
      { name: 'a.txt', data: bytes('second') },
    ])
    expect(() => readZipChecked(zip)).toThrow(/two entries named a\.txt/)
  })

  test('refuses a ZIP64 entry count', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('x') }])
    new DataView(zip.buffer).setUint16(eocdOffset(zip) + 10, 0xffff, true)
    expect(() => readZipChecked(zip)).toThrow(/ZIP64/)
  })

  test('refuses a ZIP64 entry size', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('x') }])
    new DataView(zip.buffer).setUint32(
      centralOffset(zip) + 20,
      0xffffffff,
      true
    )
    expect(() => readZipChecked(zip)).toThrow(/ZIP64/)
  })

  test('refuses a ZIP64 end-of-directory locator', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('x') }])
    const eocd = eocdOffset(zip)
    // Insert a 20-byte ZIP64 locator right before the EOCD record.
    const loc = new Uint8Array(20)
    new DataView(loc.buffer).setUint32(0, 0x07064b50, true)
    const out = new Uint8Array(zip.length + 20)
    out.set(zip.subarray(0, eocd), 0)
    out.set(loc, eocd)
    out.set(zip.subarray(eocd), eocd + 20)
    expect(() => readZipChecked(out)).toThrow(/ZIP64/)
  })
})
