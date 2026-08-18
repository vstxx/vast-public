import type { PasswordVaultInput } from './types'

export interface ParsedPasswordCsv {
  items: PasswordVaultInput[]
  skipped: number
}

function parseCsv(rawInput: string): string[][] {
  const raw = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    const next = raw[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        value += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(value)
      value = ''
    } else if (char === '\n') {
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else if (char !== '\r') {
      value += char
    }
  }

  row.push(value)
  if (row.some((item) => item.length > 0)) rows.push(row)
  return rows
}

export function parsePasswordImportCsv(raw: string): ParsedPasswordCsv {
  const rows = parseCsv(raw)
  const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) ?? []
  const index = (names: string[]): number => headers.findIndex((header) => names.includes(header))
  const titleIndex = index(['name', 'title'])
  const urlIndex = index(['url', 'origin'])
  const usernameIndex = index(['username', 'user'])
  const passwordIndex = index(['password'])
  const notesIndex = index(['note', 'notes'])

  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    throw new Error('CSV must include url, username, and password columns.')
  }

  const items: PasswordVaultInput[] = []
  let skipped = 0

  for (const row of rows) {
    const origin = row[urlIndex] ?? ''
    const password = row[passwordIndex] ?? ''
    if (!origin.trim() || password.length < 1) {
      skipped += 1
      continue
    }

    items.push({
      origin,
      username: row[usernameIndex] ?? '',
      password,
      title: titleIndex >= 0 ? row[titleIndex] : undefined,
      notes: notesIndex >= 0 ? row[notesIndex] : undefined
    })
  }

  return { items, skipped }
}
