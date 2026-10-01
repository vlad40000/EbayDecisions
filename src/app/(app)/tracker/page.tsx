import Link from 'next/link'

import { QuickMarketGrid, type QuickTrackerRow } from '@/components/quick-market-grid'
import { ResearchTracker, type ResearchTrackerRow } from '@/components/research-tracker'
import { DatabaseError } from '@/components/ui'
import { listTrackerResearchParts } from '@/db/queries'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Market Tracker — EbayDecisions' }
export const dynamic = 'force-dynamic'

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function intParam(value: string | string[] | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(first(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function pageHref(input: { q?: string; mpns: string[]; pageSize: number; advanced: boolean }, page: number) {
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.mpns.length > 0) params.set('mpns', input.mpns.join(','))
  if (input.pageSize !== 50) params.set('pageSize', String(input.pageSize))
  if (input.advanced) params.set('advanced', '1')
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/tracker?${query}` : '/tracker'
}

export default async function TrackerPage(props: { searchParams: PageSearchParams }) {
  await requireSession()
  const params = await props.searchParams
  const q = first(params.q)?.trim() || undefined
  const mpns = (first(params.mpns) ?? '').split(',').map((mpn) => mpn.trim()).filter(Boolean).slice(0, 20)
  const advanced = first(params.advanced) === '1'
  const page = intParam(params.page, 1, 1, 1_000_000)
  const pageSize = intParam(params.pageSize, 50, 1, 100)

  let result: Awaited<ReturnType<typeof listTrackerResearchParts>> | null = null
  let error: string | null = null
  try {
    result = await listTrackerResearchParts({ query: q, mpns, page, pageSize })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const rows = result?.rows ?? []
  const firstRow = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRow = result ? Math.min(result.page * result.pageSize, result.total) : 0

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-ink text-lg font-semibold tracking-tight">Market Tracker</h1>
          <p className="text-ink-faint mt-0.5 text-xs">Spreadsheet-first market research. Click an MPN for its dashboard.</p>
        </div>
        <Link
          href={advanced ? '/tracker' : '/tracker?advanced=1'}
          className="text-ink-faint hover:text-ink font-mono text-xs"
        >
          {advanced ? '← Simple view' : 'Advanced research →'}
        </Link>
      </div>

      <form action="/tracker" method="get" className="mb-3 flex flex-wrap items-end gap-2">
        {mpns.length > 0 && <input type="hidden" name="mpns" value={mpns.join(',')} />}
        {advanced && <input type="hidden" name="advanced" value="1" />}
        <label className="min-w-[280px] flex-1">
          <span className="sr-only">Search MPN or description</span>
          <input name="q" defaultValue={q ?? ''} placeholder="Search MPN or description" className="field w-full px-3 py-2 text-sm" />
        </label>
        <select name="pageSize" defaultValue={String(pageSize)} className="field px-2 py-2 font-mono text-xs">
          <option value="25">25 rows</option>
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
        </select>
        <button type="submit" className="border-line bg-surface text-ink-dim hover:text-ink rounded border px-3 py-2 text-xs">Apply</button>
        {(q || mpns.length > 0) && (
          <Link href={advanced ? '/tracker?advanced=1' : '/tracker'} className="text-ink-faint hover:text-ink px-2 py-2 text-xs">Clear</Link>
        )}
      </form>

      {error ? (
        <DatabaseError error={error} />
      ) : result ? (
        <>
          <div className="text-ink-faint mb-2 flex items-center justify-between gap-3 font-mono text-[11px]">
            <span>{firstRow}–{lastRow} of {result.total} MPNs</span>
            {mpns.length > 0 && <span>Working set · {mpns.length}</span>}
          </div>

          {advanced ? (
            <ResearchTracker rows={rows as ResearchTrackerRow[]} />
          ) : (
            <QuickMarketGrid rows={rows as QuickTrackerRow[]} />
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-ink-faint font-mono text-xs">Page {result.page} of {Math.max(1, result.pages)}</span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link href={pageHref({ q, mpns, pageSize, advanced }, result.page - 1)} className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs">← Previous</Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">← Previous</span>
              )}
              {result.pages > 0 && result.page < result.pages ? (
                <Link href={pageHref({ q, mpns, pageSize, advanced }, result.page + 1)} className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs">Next →</Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">Next →</span>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
