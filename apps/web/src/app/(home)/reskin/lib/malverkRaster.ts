// Browser (canvas) pixel I/O for the Malverk importer. The caller has already
// checked the PNG header against the size limits, so decoding is bounded.

import { loadImage } from './image'
import type { Raster, RasterIO } from './importMalverk'

export const canvasRasterIO: RasterIO = {
  async decode(bytes) {
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
      const img = await loadImage(url)
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('2D canvas context unavailable')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height)
      return { w: c.width, h: c.height, data: d.data } satisfies Raster
    } finally {
      URL.revokeObjectURL(url)
    }
  },

  async encode(r) {
    const c = document.createElement('canvas')
    c.width = r.w
    c.height = r.h
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(r.data), r.w, r.h),
      0,
      0
    )
    const blob = await new Promise<Blob | null>((res) =>
      c.toBlob(res, 'image/png')
    )
    if (!blob) throw new Error('Could not encode PNG')
    return new Uint8Array(await blob.arrayBuffer())
  },
}
