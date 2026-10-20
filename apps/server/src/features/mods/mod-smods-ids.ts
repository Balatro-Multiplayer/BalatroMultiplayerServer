import { promises as fs } from 'node:fs'
import path from 'node:path'

// The SMODS mod ids a mod's files declare: what a client running it reports
// (MPAPI.collect_installed_mods sends "<id>-<version>" per SMODS mod), and so
// what Nakama's queue allowlist has to name (queueAllowedModIds). Read from
// a pinned version's extracted folder at pin time (mod-version-hash.ts).
//
// Steamodded finds a mod by either of:
//  - a JSON manifest: an object with a string "id" and "main_file";
//  - a Lua file whose first line is "--- STEAMODDED HEADER", followed by
//    "--- KEY: value" lines, one of them "--- MOD_ID: <id>".
// One archive can hold several mods, so every manifest and header counts.

export interface ModSourceFile {
	// Relative to the mod folder, forward-slash separated.
	path: string
	content: string
}

const HEADER_FIRST_LINE = '--- STEAMODDED HEADER'
const HEADER_LINE = /^---\s*([A-Z_]+)\s*:\s*(.*?)\s*$/
// The id shape Nakama accepts (nakama/src/config.ts modIdsOf).
const SMODS_ID = /^[^\s]{1,128}$/

function manifestIdOf(content: string): string | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
	const { id, main_file: mainFile } = parsed as { id?: unknown; main_file?: unknown }
	return typeof id === 'string' && typeof mainFile === 'string' ? id : null
}

function headerIdOf(content: string): string | null {
	const lines = content.replace(/^﻿/, '').split(/\r?\n/)
	if (lines[0]?.trim() !== HEADER_FIRST_LINE) return null
	for (const line of lines.slice(1)) {
		const field = HEADER_LINE.exec(line.trim())
		if (!field) return null
		if (field[1] === 'MOD_ID') return field[2]
	}
	return null
}

function declaredIdOf(file: ModSourceFile): string | null {
	const extension = path.posix.extname(file.path).toLowerCase()
	if (extension === '.json') return manifestIdOf(file.content)
	if (extension === '.lua') return headerIdOf(file.content)
	return null
}

// Pure: every distinct id the files declare, sorted.
export function smodsIdsOfFiles(files: ModSourceFile[]): string[] {
	const ids = new Set<string>()
	for (const file of files) {
		const id = declaredIdOf(file)
		if (id && SMODS_ID.test(id)) ids.add(id)
	}
	return [...ids].sort()
}

// A manifest or header is small; a mod's big files are neither.
const MAX_SOURCE_BYTES = 256 * 1024

function couldDeclare(fileName: string): boolean {
	const extension = path.extname(fileName).toLowerCase()
	return extension === '.json' || extension === '.lua'
}

async function collectSourceFiles(root: string, dir: string, out: ModSourceFile[]): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			await collectSourceFiles(root, fullPath, out)
		} else if (entry.isFile() && couldDeclare(entry.name)) {
			const { size } = await fs.stat(fullPath)
			if (size > MAX_SOURCE_BYTES) continue
			out.push({
				path: path.relative(root, fullPath).split(path.sep).join('/'),
				content: await fs.readFile(fullPath, 'utf8'),
			})
		}
	}
}

// The ids declared anywhere under a mod folder laid out as deployed.
export async function readSmodsIds(modFolder: string): Promise<string[]> {
	const files: ModSourceFile[] = []
	await collectSourceFiles(modFolder, modFolder, files)
	return smodsIdsOfFiles(files)
}

// An admin's override, as entered: trimmed, deduplicated, sorted; null when
// any entry isn't an id (empty, whitespace inside, over 128 characters).
export function parseSmodsIdsOverride(input: unknown): string[] | null {
	if (!Array.isArray(input) || input.length > 100) return null
	const ids = new Set<string>()
	for (const entry of input) {
		if (typeof entry !== 'string') return null
		const id = entry.trim()
		if (!SMODS_ID.test(id)) return null
		ids.add(id)
	}
	return [...ids].sort()
}
