/**
 * Minimal RFC 4180 CSV reader and writer.
 *
 * Hand-rolled rather than adding a dependency, because the job is small and
 * fully specified: quoted fields, doubled quotes inside them, and newlines
 * inside quotes. Those three are what actually break naive `split(',')`
 * importers when a description contains a comma.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  // Strip a UTF-8 BOM, which Excel writes and which otherwise corrupts the
  // first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  while (i < input.length) {
    const char = input[i] as string

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }

    if (char === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }

    if (char === '\r') {
      i += 1
      continue
    }

    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }

    field += char
    i += 1
  }

  // Flush a trailing line that has no terminating newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((line) => line.some((cell) => cell.trim() !== ''))
}

function escapeCell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header.map(escapeCell).join(',')]
  for (const row of rows) lines.push(row.map(escapeCell).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/** Header lookup that tolerates case, spaces and underscores. */
export function normalizeHeader(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '')
}
