import { normalizeHeader, parseCsv, toCsv } from './csv'
import { toMpnKey } from './mpn'

/**
 * Shared manual-research CSV contract, common to Parts Engine and
 * EbayDecisions, so one file moves between the two apps without conversion.
 *
 * The canonical export writes exactly these headers in this order. Imports
 * match headers after `normalizeHeader` (case, spaces, underscores, hyphens and
 * surrounding whitespace ignored), so `90_day_sell_through_%` is the same
 * column as `90 Day Sell Through %`. Columns outside the contract are ignored.
 * When the contract grows, both apps must accept the same superset.
 */
export const SHARED_RESEARCH_CSV_HEADERS = [
  'mpn',
  'description',
  'notes',
  'New Price',
  '7 Day sales',
  '7 Day Avg Price',
  '30 Day sales',
  '30 Day Avg Price',
  '90 Day sales',
  '90 Day Avg Price',
  '90 Day Sell Through %',
] as const

export const SHARED_RESEARCH_MAX_BYTES = 2 * 1024 * 1024
export const SHARED_RESEARCH_MAX_ROWS = 5000

const MAX_AMOUNT = 1_000_000
const MAX_SELL_THROUGH_PCT = 100_000
const MAX_MPN_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 500

type SharedField =
  | 'mpn'
  | 'description'
  | 'notes'
  | 'newPrice'
  | 'sold7d'
  | 'avgPrice7d'
  | 'sold30d'
  | 'avgPrice30d'
  | 'sold90d'
  | 'avgPrice90d'
  | 'sellThrough90dPct'

type AmountKind = 'count' | 'price' | 'percent'

/** `aliases` are extra normalized spellings beyond the canonical header's own. */
const FIELDS: {
  field: SharedField
  header: (typeof SHARED_RESEARCH_CSV_HEADERS)[number]
  aliases?: string[]
}[] = [
  { field: 'mpn', header: 'mpn' },
  { field: 'description', header: 'description' },
  { field: 'notes', header: 'notes' },
  { field: 'newPrice', header: 'New Price' },
  { field: 'sold7d', header: '7 Day sales' },
  { field: 'avgPrice7d', header: '7 Day Avg Price' },
  { field: 'sold30d', header: '30 Day sales' },
  { field: 'avgPrice30d', header: '30 Day Avg Price' },
  { field: 'sold90d', header: '90 Day sales' },
  { field: 'avgPrice90d', header: '90 Day Avg Price' },
  {
    field: 'sellThrough90dPct',
    header: '90 Day Sell Through %',
    aliases: ['90daysellthroughpct', '90daysellthroughpercent'],
  },
]

const FIELD_BY_NAME = new Map<string, (typeof FIELDS)[number]>()
for (const entry of FIELDS) {
  for (const name of [normalizeHeader(entry.header), ...(entry.aliases ?? [])]) {
    FIELD_BY_NAME.set(name, entry)
  }
}

const WINDOW_FIELDS = [
  { period: '7d', sold: 'sold7d', avgPrice: 'avgPrice7d' },
  { period: '30d', sold: 'sold30d', avgPrice: 'avgPrice30d' },
  { period: '90d', sold: 'sold90d', avgPrice: 'avgPrice90d', sellThrough: 'sellThrough90dPct' },
] as const

export type SharedResearchPeriod = (typeof WINDOW_FIELDS)[number]['period']

/** One supplied lookback window. Unsupplied values stay null, never zero. */
export type SharedResearchWindow = {
  period: SharedResearchPeriod
  totalSold: number | null
  avgSoldPrice: number | null
  /** Only ever the supplied 90-day value; never derived. */
  sellThroughPct: number | null
}

export type SharedResearchRow = {
  /** 1-based line in the file, header included. */
  line: number
  mpnKey: string
  mpnDisplay: string
  description: string
  /** Operator/research context. Stored as text only, never parsed. */
  notes: string | null
  newPrice: number | null
  /** Windows with at least one supplied value; empty means no research. */
  windows: SharedResearchWindow[]
}

export type SharedResearchParseResult =
  | { ok: true; rows: SharedResearchRow[]; ignoredColumns: string[] }
  | { ok: false; kind: 'file' | 'rows'; error: string; errors: string[] }

/** Plain or comma-grouped nonnegative decimal; no sign, exponent or hex. */
const DECIMAL = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/

function readAmount(
  raw: string,
  kind: AmountKind,
  header: string,
  line: number,
): { value: number | null } | { error: string } {
  let text = raw.trim()
  if (text === '') return { value: null }
  if (kind === 'price') text = text.replace(/^\$\s*/, '')
  if (kind === 'percent') text = text.replace(/\s*%$/, '')

  const expected =
    kind === 'count'
      ? 'a whole number of 0 or more'
      : kind === 'percent'
        ? 'a percent of 0 or more'
        : 'a price of 0 or more'
  const value = DECIMAL.test(text) ? Number(text.replace(/,/g, '')) : Number.NaN
  if (!Number.isFinite(value) || (kind === 'count' && !Number.isInteger(value))) {
    return { error: `Line ${line}: "${header}" is "${raw.trim()}"; expected ${expected}, or leave it blank.` }
  }

  const max = kind === 'percent' ? MAX_SELL_THROUGH_PCT : MAX_AMOUNT
  if (value > max) {
    return { error: `Line ${line}: "${header}" is over ${max.toLocaleString('en-US')} — check for a typo.` }
  }
  return { value }
}

/**
 * Parses and validates a whole shared research CSV before anything is saved.
 *
 * Any row-level problem fails the whole file (`kind: 'rows'`), so a corrected
 * file can be re-uploaded without having saved half of the previous attempt.
 * Blank cells and missing columns are unknown (null). Sell-through is taken
 * only from the supplied `90 Day Sell Through %` cell; it is never derived.
 */
export function parseSharedResearchCsv(text: string): SharedResearchParseResult {
  const table = parseCsv(text)
  const header = table[0]
  if (!header || table.length < 2) {
    return { ok: false, kind: 'file', error: 'The file needs a header row and at least one data row.', errors: [] }
  }

  const positions = new Map<SharedField, number>()
  const ignoredColumns: string[] = []
  for (const [position, name] of header.entries()) {
    const entry = FIELD_BY_NAME.get(normalizeHeader(name))
    if (!entry) {
      if (name.trim() !== '') ignoredColumns.push(name.trim())
      continue
    }
    const earlier = positions.get(entry.field)
    if (earlier !== undefined) {
      return {
        ok: false,
        kind: 'file',
        error: `Columns "${header[earlier]?.trim()}" and "${name.trim()}" are both "${entry.header}". Keep one.`,
        errors: [],
      }
    }
    positions.set(entry.field, position)
  }

  if (!positions.has('mpn')) {
    return {
      ok: false,
      kind: 'file',
      error: `No mpn column found. Header was: ${header.map((name) => name.trim()).join(', ')}`,
      errors: [],
    }
  }

  const body = table.slice(1)
  if (body.length > SHARED_RESEARCH_MAX_ROWS) {
    return {
      ok: false,
      kind: 'file',
      error: `The file has ${body.length} data rows; the limit is ${SHARED_RESEARCH_MAX_ROWS}. Split it and import each part.`,
      errors: [],
    }
  }

  const cell = (row: string[], field: SharedField): string => {
    const position = positions.get(field)
    return position === undefined ? '' : (row[position] ?? '').trim()
  }
  const headerOf = (field: SharedField) => FIELDS.find((entry) => entry.field === field)?.header ?? field

  const rows: SharedResearchRow[] = []
  const errors: string[] = []
  const linesByKey = new Map<string, number[]>()

  for (const [offset, row] of body.entries()) {
    const line = offset + 2
    const mpnDisplay = cell(row, 'mpn')
    if (!mpnDisplay) {
      errors.push(`Line ${line}: no MPN.`)
      continue
    }
    if (mpnDisplay.length > MAX_MPN_LENGTH) {
      errors.push(`Line ${line}: MPN is longer than ${MAX_MPN_LENGTH} characters.`)
      continue
    }
    const mpnKey = toMpnKey(mpnDisplay)
    if (!mpnKey) {
      errors.push(`Line ${line}: MPN "${mpnDisplay}" has no letters or digits.`)
      continue
    }

    const description = cell(row, 'description')
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`Line ${line} (${mpnDisplay}): description is longer than ${MAX_DESCRIPTION_LENGTH} characters.`)
      continue
    }

    const rowErrors: string[] = []
    const amount = (field: SharedField, kind: AmountKind): number | null => {
      const parsed = readAmount(cell(row, field), kind, headerOf(field), line)
      if ('error' in parsed) {
        rowErrors.push(parsed.error)
        return null
      }
      return parsed.value
    }

    const newPrice = amount('newPrice', 'price')
    const windows: SharedResearchWindow[] = []
    for (const spec of WINDOW_FIELDS) {
      const window: SharedResearchWindow = {
        period: spec.period,
        totalSold: amount(spec.sold, 'count'),
        avgSoldPrice: amount(spec.avgPrice, 'price'),
        sellThroughPct: 'sellThrough' in spec ? amount(spec.sellThrough, 'percent') : null,
      }
      if (window.totalSold != null || window.avgSoldPrice != null || window.sellThroughPct != null) {
        windows.push(window)
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
      continue
    }

    linesByKey.set(mpnKey, [...(linesByKey.get(mpnKey) ?? []), line])
    rows.push({
      line,
      mpnKey,
      mpnDisplay,
      description,
      notes: cell(row, 'notes') || null,
      newPrice,
      windows,
    })
  }

  for (const [mpnKey, lines] of linesByKey) {
    if (lines.length > 1) {
      errors.push(`Lines ${lines.join(', ')}: the same MPN (key ${mpnKey}) appears more than once. Keep one row per MPN.`)
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      kind: 'rows',
      error: `${errors.length} problem${errors.length === 1 ? '' : 's'} found; nothing was imported. Fix the file and upload it again.`,
      errors,
    }
  }

  return { ok: true, rows, ignoredColumns }
}

export type SharedResearchExportRow = {
  mpn: string
  description: string
  notes: string | null
  newPrice: string | number | null
  sold7d: number | null
  avgPrice7d: string | number | null
  sold30d: number | null
  avgPrice30d: string | number | null
  sold90d: number | null
  avgPrice90d: string | number | null
  sellThrough90dPct: string | number | null
}

/** Canonical shared export. Unknown values are written blank, never zero. */
export function buildSharedResearchCsv(rows: SharedResearchExportRow[]): string {
  return toCsv(
    [...SHARED_RESEARCH_CSV_HEADERS],
    rows.map((row) => [
      row.mpn,
      row.description,
      row.notes,
      row.newPrice,
      row.sold7d,
      row.avgPrice7d,
      row.sold30d,
      row.avgPrice30d,
      row.sold90d,
      row.avgPrice90d,
      row.sellThrough90dPct,
    ]),
  )
}
