// Turn a user-picked Malverk pack (a .zip or a folder) into the file map the
// importer reads. Only the file types the importer can use are read, within
// the size limits of MALVERK_IMPORT.md section 1, so a huge or hostile pack is
// refused before its bytes are pulled into memory.

import {
  MAX_FILES,
  MAX_LUA_FILE,
  MAX_OGG_BYTES,
  MAX_PNG_BYTES,
} from './importMalverk'
import { readZipChecked } from './zip'

const READ_LIMITS: [RegExp, number][] = [
  [/\.lua$/i, MAX_LUA_FILE],
  [/\.png$/i, MAX_PNG_BYTES],
  [/\.ogg$/i, MAX_OGG_BYTES],
  [/\.json$/i, 1024 * 1024],
]

function limitFor(name: string): number | null {
  for (const [re, max] of READ_LIMITS) if (re.test(name)) return max
  return null
}

/** Folder picked with <input webkitdirectory>. */
export async function filesFromFolder(
  list: FileList
): Promise<Map<string, Uint8Array>> {
  if (list.length > MAX_FILES)
    throw new Error('This folder has too many files.')
  const out = new Map<string, Uint8Array>()
  for (const f of Array.from(list)) {
    const rel =
      (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const max = limitFor(rel)
    if (max === null || f.size > max) continue
    out.set(rel, new Uint8Array(await f.arrayBuffer()))
  }
  return out
}

/** A .zip; the Studio's reader handles uncompressed (STORE) entries only. */
export async function filesFromZip(
  file: File
): Promise<Map<string, Uint8Array>> {
  const { files, unsupported, symlinks } = readZipChecked(
    new Uint8Array(await file.arrayBuffer())
  )
  if (files.size === 0 && unsupported > 0)
    throw new Error(
      'This ZIP uses compression the Studio cannot read. Extract it and pick the folder instead (or use the launcher, which reads all ZIPs).'
    )
  if (unsupported > 0)
    throw new Error(
      `${unsupported} file${unsupported === 1 ? '' : 's'} in this ZIP use compression the Studio cannot read. Extract it and pick the folder instead.`
    )
  if (symlinks > 0)
    throw new Error('This ZIP contains symbolic links, which are not allowed.')
  const out = new Map<string, Uint8Array>()
  for (const [name, bytes] of files) {
    const max = limitFor(name)
    if (max === null || bytes.length > max) continue
    out.set(name, bytes)
  }
  return out
}
