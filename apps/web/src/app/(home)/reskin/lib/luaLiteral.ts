// Literal-only reader for Lua source (MALVERK_IMPORT.md section 4).
//
// This NEVER evaluates Lua. It tokenizes Lua 5.1/LuaJIT source in one linear
// pass and pulls plain data out of `AltTexture{...}` / `TexturePack{...}` /
// `SMODS.Sound{...}` table constructors and `return {...}` tables. Anything
// that is not a literal (a variable, call, concatenation, function, ...) is
// reported as UNRESOLVED and skipped, never guessed at.

export const MAX_TOKENS = 1_000_000
export const MAX_TABLE_DEPTH = 16

/** Thrown when a hard limit is exceeded; the importer rejects the whole pack. */
export class LuaLimitError extends Error {}

export const UNRESOLVED = Symbol('unresolved')

export type LuaValue =
  | string
  | number
  | boolean
  | null
  | LuaTable
  | typeof UNRESOLVED

export interface LuaTable {
  /** Positional items, in order (an unresolved item keeps its slot). */
  array: LuaValue[]
  /** `name = v`, `["str"] = v`, `[number] = v` (number keys as decimal text). */
  fields: Map<string, LuaValue>
  /** True when any item or key in this table (not nested ones) was not a literal. */
  unresolved: boolean
}

type TokKind = 'name' | 'str' | 'num' | 'punct' | 'eof'
interface Tok {
  k: TokKind
  v: string
  n?: number
}

const EOF: Tok = { k: 'eof', v: '' }

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}
function isNameChar(c: number): boolean {
  return isNameStart(c) || isDigit(c)
}

/** True when src[at] is an exponent letter (`e` decimal / `p` hex) of the number starting at s. */
function isExponentMark(src: string, s: number, at: number): boolean {
  const hex = src[s] === '0' && (src[s + 1] === 'x' || src[s + 1] === 'X')
  const ch = src[at]
  return hex ? ch === 'p' || ch === 'P' : ch === 'e' || ch === 'E'
}

/** Length of a long-bracket opener `[==[` at i (returns level, or -1). */
function longBracketLevel(s: string, i: number): number {
  if (s.charCodeAt(i) !== 91) return -1
  let j = i + 1
  let level = 0
  while (s.charCodeAt(j) === 61) {
    level++
    j++
  }
  return s.charCodeAt(j) === 91 ? level : -1
}

/** Index just past the closing bracket of a long string starting at `i`. */
function skipLongBracket(
  s: string,
  i: number,
  level: number
): { end: number; body: string } {
  const open = i + level + 2
  const close = `]${'='.repeat(level)}]`
  const at = s.indexOf(close, open)
  if (at < 0) return { end: s.length, body: s.slice(open) }
  let body = s.slice(open, at)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { end: at + close.length, body }
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const len = src.length
  let i = 0
  const push = (t: Tok) => {
    if (toks.length >= MAX_TOKENS)
      throw new LuaLimitError('A Lua file has too many tokens.')
    toks.push(t)
  }

  while (i < len) {
    const c = src.charCodeAt(i)
    // whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      i++
      continue
    }
    // comments
    if (c === 45 && src.charCodeAt(i + 1) === 45) {
      i += 2
      const lvl = longBracketLevel(src, i)
      if (lvl >= 0) {
        i = skipLongBracket(src, i, lvl).end
      } else {
        while (i < len && src.charCodeAt(i) !== 10) i++
      }
      continue
    }
    // names
    if (isNameStart(c)) {
      const s = i
      while (i < len && isNameChar(src.charCodeAt(i))) i++
      push({ k: 'name', v: src.slice(s, i) })
      continue
    }
    // numbers (also `.5`)
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      const s = i
      i++
      while (i < len) {
        const d = src.charCodeAt(i)
        if (isNameChar(d) || d === 46) {
          i++
        } else if ((d === 43 || d === 45) && isExponentMark(src, s, i - 1)) {
          i++
        } else break
      }
      const text = src.slice(s, i)
      push({ k: 'num', v: text, n: Number(text) })
      continue
    }
    // short strings
    if (c === 34 || c === 39) {
      const quote = c
      i++
      let out = ''
      let closed = false
      while (i < len) {
        const d = src.charCodeAt(i)
        if (d === quote) {
          i++
          closed = true
          break
        }
        if (d === 10) break // unterminated; stop at the newline
        if (d === 92) {
          i++
          const e = src[i]
          i++
          switch (e) {
            case 'n':
              out += '\n'
              break
            case 't':
              out += '\t'
              break
            case 'r':
              out += '\r'
              break
            case 'a':
              out += '\x07'
              break
            case 'b':
              out += '\b'
              break
            case 'f':
              out += '\f'
              break
            case 'v':
              out += '\v'
              break
            case '\\':
              out += '\\'
              break
            case '"':
              out += '"'
              break
            case "'":
              out += "'"
              break
            case '\n':
              out += '\n'
              break
            case 'z':
              while (i < len && /\s/.test(src[i]!)) i++
              break
            case 'x': {
              const hex = src.slice(i, i + 2)
              if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                out += String.fromCharCode(parseInt(hex, 16))
                i += 2
              }
              break
            }
            default:
              if (e !== undefined && isDigit(e.charCodeAt(0))) {
                let digits = e
                while (digits.length < 3 && isDigit(src.charCodeAt(i)))
                  digits += src[i++]
                out += String.fromCharCode(Math.min(255, Number(digits)))
              } else if (e !== undefined) out += e
          }
          continue
        }
        out += src[i]
        i++
      }
      void closed
      push({ k: 'str', v: out })
      continue
    }
    // long strings
    if (c === 91) {
      const lvl = longBracketLevel(src, i)
      if (lvl >= 0) {
        const r = skipLongBracket(src, i, lvl)
        i = r.end
        push({ k: 'str', v: r.body })
        continue
      }
    }
    // punctuation (multi-char first)
    const three = src.slice(i, i + 3)
    if (three === '...') {
      push({ k: 'punct', v: '...' })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (
      two === '..' ||
      two === '==' ||
      two === '~=' ||
      two === '<=' ||
      two === '>=' ||
      two === '::'
    ) {
      push({ k: 'punct', v: two })
      i += 2
      continue
    }
    push({ k: 'punct', v: src[i]! })
    i++
  }
  return toksWithEof(toks)
}

function toksWithEof(t: Tok[]): Tok[] {
  t.push(EOF)
  return t
}

const BLOCK_OPEN = new Set(['function', 'if', 'do', 'repeat'])
const BLOCK_CLOSE = new Set(['end', 'until'])

class Parser {
  constructor(
    private readonly t: Tok[],
    public i = 0
  ) {}

  peek(o = 0): Tok {
    return this.t[Math.min(this.i + o, this.t.length - 1)]!
  }

  private isTerminator(tok: Tok): boolean {
    return (
      tok.k === 'eof' ||
      (tok.k === 'punct' && (tok.v === ',' || tok.v === ';' || tok.v === '}'))
    )
  }

  /** Skip one expression up to (not including) a `,` `;` or `}` at nesting 0. */
  private skipExpression(): void {
    let depth = 0
    for (;;) {
      const tok = this.peek()
      if (tok.k === 'eof') return
      if (tok.k === 'punct') {
        if (tok.v === '{' || tok.v === '(' || tok.v === '[') depth++
        else if (tok.v === '}' || tok.v === ')' || tok.v === ']') {
          if (depth === 0) return
          depth--
        } else if ((tok.v === ',' || tok.v === ';') && depth === 0) return
      } else if (tok.k === 'name') {
        if (BLOCK_OPEN.has(tok.v)) depth++
        else if (BLOCK_CLOSE.has(tok.v) && depth > 0) depth--
      }
      this.i++
    }
  }

  /** Parse one field/array value. Leaves the cursor on the terminator. */
  private parseValue(depth: number): LuaValue {
    const start = this.i
    let v: LuaValue = UNRESOLVED
    const tok = this.peek()

    if (tok.k === 'str') {
      this.i++
      v = tok.v
    } else if (tok.k === 'num') {
      this.i++
      v = tok.n ?? 0
    } else if (tok.k === 'punct' && tok.v === '-' && this.peek(1).k === 'num') {
      this.i += 2
      v = -(this.t[this.i - 1]!.n ?? 0)
    } else if (
      tok.k === 'name' &&
      (tok.v === 'true' || tok.v === 'false' || tok.v === 'nil')
    ) {
      this.i++
      v = tok.v === 'true' ? true : tok.v === 'false' ? false : null
    } else if (tok.k === 'punct' && tok.v === '{') {
      v = this.parseTable(depth + 1)
    }

    if (v !== UNRESOLVED && this.isTerminator(this.peek())) return v
    // Not a pure literal (e.g. `"a" .. b`, `f(x)`): skip the whole expression.
    this.i = start
    this.skipExpression()
    return UNRESOLVED
  }

  /** Cursor on `{`. Returns after the matching `}`. */
  parseTable(depth: number): LuaTable {
    if (depth > MAX_TABLE_DEPTH)
      throw new LuaLimitError('A Lua table is nested too deeply.')
    const table: LuaTable = { array: [], fields: new Map(), unresolved: false }
    this.i++ // {
    for (;;) {
      const tok = this.peek()
      if (tok.k === 'eof') return table
      if (tok.k === 'punct' && tok.v === '}') {
        this.i++
        return table
      }
      if (tok.k === 'punct' && (tok.v === ',' || tok.v === ';')) {
        this.i++
        continue
      }

      // `name = value`
      if (
        tok.k === 'name' &&
        this.peek(1).k === 'punct' &&
        this.peek(1).v === '='
      ) {
        this.i += 2
        const v = this.parseValue(depth)
        if (v === UNRESOLVED) table.unresolved = true
        table.fields.set(tok.v, v)
        continue
      }
      // `[key] = value`
      if (tok.k === 'punct' && tok.v === '[') {
        const kTok = this.peek(1)
        const close = this.peek(2)
        const eq = this.peek(3)
        if (
          (kTok.k === 'str' || kTok.k === 'num') &&
          close.k === 'punct' &&
          close.v === ']' &&
          eq.k === 'punct' &&
          eq.v === '='
        ) {
          this.i += 4
          const v = this.parseValue(depth)
          if (v === UNRESOLVED) table.unresolved = true
          table.fields.set(kTok.k === 'str' ? kTok.v : String(kTok.n), v)
          continue
        }
        // computed key: skip the key bracket and the value
        table.unresolved = true
        this.skipExpression()
        continue
      }
      // positional value
      const v = this.parseValue(depth)
      if (v === UNRESOLVED) table.unresolved = true
      table.array.push(v)
    }
  }
}

export type DefinitionKind = 'AltTexture' | 'TexturePack' | 'SMODS.Sound'

export interface LuaDefinition {
  kind: DefinitionKind
  table: LuaTable
}

/** Find every `AltTexture{..}`, `TexturePack{..}` and `SMODS.Sound{..}` call. */
export function extractDefinitions(src: string): LuaDefinition[] {
  const t = tokenize(src)
  const out: LuaDefinition[] = []
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!
    if (tok.k !== 'name') continue
    let kind: DefinitionKind | null = null
    let calleeStart = i
    const prev = t[i - 1]
    if (tok.v === 'AltTexture' || tok.v === 'TexturePack') {
      kind = tok.v
    } else if (
      tok.v === 'SMODS' &&
      t[i + 1]?.v === '.' &&
      t[i + 2]?.k === 'name' &&
      t[i + 2]?.v === 'Sound'
    ) {
      kind = 'SMODS.Sound'
      calleeStart = i
      i += 2
    }
    if (!kind) continue
    // callee must stand alone: not `x.AltTexture`, `x:AltTexture`, or `function AltTexture`
    const before = t[calleeStart - 1] ?? prev
    if (
      before &&
      ((before.k === 'punct' && (before.v === '.' || before.v === ':')) ||
        (before.k === 'name' && before.v === 'function'))
    )
      continue

    let j = i + 1
    if (t[j]?.k === 'punct' && t[j]?.v === '(') j++
    if (!(t[j]?.k === 'punct' && t[j]?.v === '{')) continue

    const p = new Parser(t, j)
    out.push({ kind, table: p.parseTable(1) })
    i = p.i - 1
  }
  return out
}

/** Parse the table of the first `return { ... }` (a localization file). */
export function parseReturnTable(src: string): LuaTable | null {
  const t = tokenize(src)
  for (let i = 0; i < t.length - 1; i++) {
    if (
      t[i]!.k === 'name' &&
      t[i]!.v === 'return' &&
      t[i + 1]!.k === 'punct' &&
      t[i + 1]!.v === '{'
    )
      return new Parser(t, i + 1).parseTable(1)
  }
  return null
}

// ---- small accessors -------------------------------------------------------

export function getString(t: LuaTable, name: string): string | undefined {
  const v = t.fields.get(name)
  return typeof v === 'string' ? v : undefined
}
export function getNumber(t: LuaTable, name: string): number | undefined {
  const v = t.fields.get(name)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
export function getBool(t: LuaTable, name: string): boolean | undefined {
  const v = t.fields.get(name)
  return typeof v === 'boolean' ? v : undefined
}
/**
 * Lua truthiness of a literal field: anything except nil/false is true, so
 * `original_sheet = 'true'` (a string) counts. An absent or unresolved field is
 * false (check isFieldUnresolved separately to warn about the latter).
 */
export function isTruthy(t: LuaTable, name: string): boolean {
  const v = t.fields.get(name)
  return v !== undefined && v !== null && v !== false && v !== UNRESOLVED
}
export function isFieldUnresolved(t: LuaTable, name: string): boolean {
  return t.fields.get(name) === UNRESOLVED
}
/** An array of strings, or null when absent / not a pure string array. */
export function getStringList(t: LuaTable, name: string): string[] | null {
  const v = t.fields.get(name)
  if (!v || typeof v !== 'object' || v === null || !('array' in v)) return null
  const out: string[] = []
  for (const x of v.array) {
    if (typeof x !== 'string') return null
    out.push(x)
  }
  return out
}
export function getTable(t: LuaTable, name: string): LuaTable | null {
  const v = t.fields.get(name)
  return v && typeof v === 'object' && 'array' in v ? v : null
}
