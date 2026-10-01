import Link from 'next/link'

import { ResearchTracker, type ResearchTrackerRow } from '@/components/research-tracker'
import { DatabaseError, Notice, PageHeader } from '@/components/ui'
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

function pageHref(input: {
  q?: string
  mpns: string[]
  pageSize: number
}, page: number) {
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.mpns.length > 0) params.set('mpns', input.mpns.join(','))
  if (input.pageSize !== 50) params.set('pageSize', String(input.pageSize))
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/tracker?${query}` : '/tracker'
}

export default async function TrackerPage(props: { searchParams: PageSearchParams }) {
  await requireSession()

  const params = await props.searchParams
  const q = first(params.q)?.trim() || undefined
  const mpns = (first(params.mpns) ?? '')
    .split(',')
    .map((mpn) => mpn.trim())
    .filter(Boolean)
    .slice(0, 20)
  const page = intParam(params.page, 1, 1, 1_000_000)
  const pageSize = intParam(params.pageSize, 50, 1, 100)

  let result: Awaited<ReturnType<typeof listTrackerResearchParts>> | null = null
  let error: string | null = null

  try {
    result = await listTrackerResearchParts({ query: q, mpns, page, pageSize })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const rows: ResearchTrackerRow[] = result?.rows ?? []
  const researchNowMs = Date.now()
  const firstRow = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRow = result ? Math.min(result.page * result.pageSize, result.total) : 0

  return (
    <div>
      <PageHeader
        title="Market Tracker"
        subtitle="eBay Active and Sold research by MPN only. The five period quantities are total SOLD, not active listings."
      />

      <div className="mb-4">
        <Notice tone="info">
          Open <strong>Active eBay</strong> and <strong>Sold eBay</strong> from an MPN row. Both use only
          the supplied MPN. <strong>Capture Active</strong> can append a point-in-time Active snapshot;
          Sold research remains separate and is saved only through <strong>SAVE RESEARCH</strong>.
        </Notice>
      </div>

      <form action="/tracker" method="get" className="bg-surface border-line mb-4 rounded border p-3">
        {mpns.length > 0 && <input type="hidden" name="mpns" value={mpns.join(',')} />}
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[260px] flex-1">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Search MPN / Description
            </span>
            <input
              name="q"
              defaultValue={q ?? ''}
              placeholder="W10830046 or gasket"
              className="field w-full px-3 py-2 text-sm"
            />
          </label>
          <label className="text-ink-dim flex items-center gap-2 text-xs">
            Rows
            <select name="pageSize" defaultValue={String(pageSize)} className="field px-2 py-1.5 font-mono text-xs">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
          <button
            type="submit"
            className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-2 text-xs font-medium transition-colors"
          >
            Apply
          </button>
          <Link
            href="/tracker"
            className="border-line text-ink-dim hover:text-ink rounded border px-3 py-2 text-xs transition-colors"
          >
            Reset
          </Link>
        </div>
      </form>

      {mpns.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ChipWorkingSet mpns={mpns} />
          <Link href="/research" className="text-info hover:text-good text-xs">
            Change working set →
          </Link>
        </div>
      )}

      {error ? (
        <DatabaseError error={error} />
      ) : result ? (
        <>
          <div className="text-ink-faint mb-2 font-mono text-xs">
            Showing {firstRow}–{lastRow} of {result.total} MPNs
          </div>
          <ResearchTracker rows={rows} researchNowMs={researchNowMs} />

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-ink-faint font-mono text-xs">
              Page {result.page} of {Math.max(1, result.pages)}
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={pageHref({ q, mpns, pageSize }, result.page - 1)}
                  className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">← Previous</span>
              )}
              {result.pages > 0 && result.page < result.pages ? (
                <Link
                  href={pageHref({ q, mpns, pageSize }, result.page + 1)}
                  className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
                >
                  Next →
                </Link>
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

function ChipWorkingSet({ mpns }: { mpns: string[] }) {
  return (
    <span className="border-info/25 bg-info/10 text-info rounded border px-2 py-1 font-mono text-xs">
      Working set · {mpns.length} MPN{mpns.length === 1 ? '' : 's'}
    </span>
  )
}
