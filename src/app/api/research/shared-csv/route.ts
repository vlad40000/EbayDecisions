import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'

import {
  importSharedResearchRows,
  listSharedResearchExportRows,
  type SharedResearchExportScope,
} from '@/db/queries'
import { hasValidSession } from '@/lib/session'
import {
  buildSharedResearchCsv,
  parseSharedResearchCsv,
  SHARED_RESEARCH_MAX_BYTES,
} from '@/lib/shared-research-csv'

/**
 * Shared manual-research CSV, the file format Parts Engine and EbayDecisions
 * both read and write (see src/lib/shared-research-csv.ts).
 *
 * GET downloads the canonical export: every active part (`?scope=all`, the
 * default) or the Research Queue's due rows (`?scope=due`, with an optional
 * `staleDays`). POST imports a completed file into dated manual research
 * sessions. Both work in manual-only mode: neither makes an eBay request.
 *
 * The full diagnostic export stays at /api/parts/export.
 */
export async function GET(request: Request) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const scope: SharedResearchExportScope = params.get('scope') === 'due' ? 'due' : 'all'
  const staleDays = Number(params.get('staleDays') ?? 30)

  const rows = await listSharedResearchExportRows({
    scope,
    staleDays: Number.isFinite(staleDays) ? staleDays : 30,
  })

  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(buildSharedResearchCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="research-${scope === 'due' ? 'queue' : 'all'}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function POST(request: Request) {
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
  if (file.size > SHARED_RESEARCH_MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB.` },
      { status: 413 },
    )
  }

  const parsed = parseSharedResearchCsv(await file.text())
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, errors: parsed.errors.slice(0, 25), errorCount: parsed.errors.length },
      { status: parsed.kind === 'file' ? 400 : 422 },
    )
  }

  // Import time stands in as the research date until the shared format gains
  // an explicit research-date column.
  const summary = await importSharedResearchRows(parsed.rows, { researchedAt: new Date() })

  revalidatePath('/opportunities')
  revalidatePath('/research')
  revalidatePath('/tracker')
  revalidatePath('/inventory')

  const message = [
    `${summary.sessions} research session${summary.sessions === 1 ? '' : 's'} saved (${summary.windows} windows).`,
    `${summary.registered} new MPN${summary.registered === 1 ? '' : 's'} registered.`,
    `${summary.newPrices} New Price value${summary.newPrices === 1 ? '' : 's'} saved.`,
  ]
  if (summary.errors.length > 0) message.push(`${summary.errors.length} rows could not be saved.`)
  if (parsed.ignoredColumns.length > 0) message.push(`Ignored columns: ${parsed.ignoredColumns.join(', ')}.`)

  return NextResponse.json({
    rows: parsed.rows.length,
    registered: summary.registered,
    existing: summary.existing,
    sessions: summary.sessions,
    windows: summary.windows,
    newPrices: summary.newPrices,
    ignoredColumns: parsed.ignoredColumns,
    errors: summary.errors.slice(0, 25),
    errorCount: summary.errors.length,
    message: message.join(' '),
  })
}
