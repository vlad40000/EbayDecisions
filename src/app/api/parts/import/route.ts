import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'

import { upsertPartByMpn, type PartInput } from '@/db/queries'
import { normalizeHeader, parseCsv } from '@/lib/csv'
import { toNumber } from '@/lib/format'
import { hasValidSession } from '@/lib/session'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 5000
const MAX_AMOUNT = 1_000_000

/** Accepted header spellings, normalised (case, spaces and underscores ignored). */
const COLUMNS = {
  mpn: ['mpn', 'partnumber', 'part', 'sku'],
  description: ['description', 'desc', 'name'],
  inventoryQty: ['inventoryqty', 'qty', 'quantity', 'onhand'],
  costBasis: ['costbasis', 'cost', 'mycost', 'paid'],
  shipCost: ['shipcost', 'shippingcost', 'myshipping'],
  targetMarginPct: ['targetmarginpct', 'targetmargin', 'target'],
  sourceUrl: ['sourceurl', 'url', 'link', 'source'],
  notes: ['notes', 'note', 'comment'],
} as const

function buildIndex(header: string[]): Partial<Record<keyof typeof COLUMNS, number>> {
  const normalized = header.map(normalizeHeader)
  const index: Partial<Record<keyof typeof COLUMNS, number>> = {}

  for (const [field, aliases] of Object.entries(COLUMNS) as [
    keyof typeof COLUMNS,
    readonly string[],
  ][]) {
    const position = normalized.findIndex((name) => aliases.includes(name))
    if (position !== -1) index[field] = position
  }

  return index
}

/**
 * Bulk upsert of the catalogue from a CSV.
 *
 * Matches on MPN, so re-importing a corrected file updates in place rather than
 * duplicating. Only the columns present in the file are touched: a CSV of just
 * `mpn,cost_basis` fills in cost bases and leaves descriptions alone, which is
 * the common case when loading 63 costs at once.
 */
export async function POST(request: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Attach a CSV file in the "file" field.' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.` },
      { status: 413 },
    )
  }

  const rows = parseCsv(await file.text())
  const header = rows[0]

  if (!header || rows.length < 2) {
    return NextResponse.json(
      { error: 'The file needs a header row and at least one data row.' },
      { status: 400 },
    )
  }

  const index = buildIndex(header)
  if (index.mpn === undefined) {
    return NextResponse.json(
      { error: `No MPN column found. Header was: ${header.join(', ')}` },
      { status: 400 },
    )
  }

  const body = rows.slice(1, MAX_ROWS + 1)
  const cell = (row: string[], field: keyof typeof COLUMNS): string | undefined => {
    const position = index[field]
    return position === undefined ? undefined : row[position]?.trim()
  }

  let inserted = 0
  let updated = 0
  const errors: string[] = []

  for (const [offset, row] of body.entries()) {
    const line = offset + 2
    const mpn = cell(row, 'mpn')

    if (!mpn) {
      errors.push(`Line ${line}: no MPN.`)
      continue
    }

    const description = cell(row, 'description')
    const input: PartInput = { mpn, description: description || mpn }

    // Only assign fields the file actually carries, so a partial CSV does not
    // blank out data it never mentioned.
    const qty = cell(row, 'inventoryQty')
    if (qty !== undefined && qty !== '') {
      const parsed = toNumber(qty)
      if (parsed == null || parsed < 0 || parsed > MAX_AMOUNT) {
        errors.push(`Line ${line}: quantity "${qty}" is not a usable number.`)
        continue
      }
      input.inventoryQty = Math.round(parsed)
    }

    for (const field of ['costBasis', 'shipCost', 'targetMarginPct'] as const) {
      const raw = cell(row, field)
      if (raw === undefined) continue
      if (raw === '') {
        input[field] = null
        continue
      }
      const parsed = toNumber(raw.replace(/^\$/, ''))
      if (parsed == null || parsed < 0 || parsed > MAX_AMOUNT) {
        errors.push(`Line ${line}: ${field} "${raw}" is not a usable number.`)
        continue
      }
      input[field] = parsed
    }

    const url = cell(row, 'sourceUrl')
    if (url !== undefined) input.sourceUrl = url === '' ? null : url

    const notes = cell(row, 'notes')
    if (notes !== undefined) input.notes = notes === '' ? null : notes

    try {
      const outcome = await upsertPartByMpn(input)
      if (outcome === 'inserted') inserted += 1
      else updated += 1
    } catch (error) {
      errors.push(`Line ${line} (${mpn}): ${error instanceof Error ? error.message : 'failed'}`)
    }
  }

  revalidatePath('/inventory')
  revalidatePath('/decisions')
  revalidatePath('/tracker')

  const skipped = rows.length - 1 - body.length
  const summary = [`${inserted} added, ${updated} updated.`]
  if (errors.length > 0) summary.push(`${errors.length} rows had problems.`)
  if (skipped > 0) summary.push(`${skipped} rows past the ${MAX_ROWS}-row limit were ignored.`)

  return NextResponse.json({
    inserted,
    updated,
    errors: errors.slice(0, 25),
    errorCount: errors.length,
    message: summary.join(' '),
  })
}
