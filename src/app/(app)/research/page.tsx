import Link from 'next/link'

import {
  ResearchQueueTable,
  type ResearchQueueTableRow,
} from '@/components/research-queue-table'
import { DatabaseError, EmptyState, PageHeader } from '@/components/ui'
import {
  listResearchQueue,
  type ResearchQueueState,
} from '@/db/queries'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Research Queue — EbayDecisions' }
export const dynamic = 'force-dynamic'

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>

const STATES = new Set<ResearchQueueState>(['due', 'all', 'never', 'stale', 'current'])

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function intParam(
  value: string | string[] | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(first(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function hrefFor(input: {
  query?: string
  state: ResearchQueueState
  staleDays: number
  includeZeroInventory: boolean
  pageSize: number
}, page: number) {
  const params = new URLSearchParams()
  if (input.query) params.set('q', input.query)
  if (input.state !== 'due') params.set('state', input.state)
  if (input.staleDays !== 30) params.set('staleDays', String(input.staleDays))
  if (input.includeZeroInventory) params.set('includeZero', '1')
  if (input.pageSize !== 50) params.set('pageSize', String(input.pageSize))
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/research?${query}` : '/research'
}

export default async function ResearchQueuePage(props: { searchParams: PageSearchParams }) {
  await requireSession()

  const params = await props.searchParams
  const requestedState = first(params.state)
  const state =
    requestedState && STATES.has(requestedState as ResearchQueueState)
      ? (requestedState as ResearchQueueState)
      : 'due'
  const staleDays = intParam(params.staleDays, 30, 1, 3650)
  const page = intParam(params.page, 1, 1, 1_000_000)
  const pageSize = intParam(params.pageSize, 50, 1, 100)
  const query = first(params.q)?.trim() || undefined
  const includeZeroInventory = first(params.includeZero) === '1'

  let result: Awaited<ReturnType<typeof listResearchQueue>> | null = null
  let error: string | null = null

  try {
    result = await listResearchQueue({
      query,
      state,
      staleDays,
      inStock: !includeZeroInventory,
      page,
      pageSize,
    })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const rows: ResearchQueueTableRow[] = result?.rows ?? []
  const firstRow = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRow = result ? Math.min(result.page * result.pageSize, result.total) : 0

  return (
    <div>
      <PageHeader
        title="Research Queue"
        subtitle="Build a deliberate working set of MPNs to research next. Nothing here calls eBay or writes to Neon."
      />

      <form action="/research" method="get" className="bg-surface border-line mb-4 rounded border p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(280px,2fr)_1fr_1fr_auto]">
          <label>
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Search MPN / Description
            </span>
            <input
              name="q"
              defaultValue={query ?? ''}
              placeholder="W10830046 or gasket"
              className="field w-full px-3 py-2 text-sm"
            />
          </label>

          <label>
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Queue state
            </span>
            <select name="state" defaultValue={state} className="field w-full px-2 py-2 text-sm">
              <option value="due">Due: never + stale</option>
              <option value="never">Never researched</option>
              <option value="stale">Stale</option>
              <option value="current">Current</option>
              <option value="all">All</option>
            </select>
          </label>

          <label>
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Stale after
            </span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                name="staleDays"
                min="1"
                max="3650"
                defaultValue={staleDays}
                className="field w-full px-2 py-2 text-right font-mono text-sm"
              />
              <span className="text-ink-faint text-xs">days</span>
            </div>
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              className="border-good/40 bg-good/10 text-good hover:bg-good/20 w-full rounded border px-3 py-2 text-xs font-medium transition-colors"
            >
              Apply
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-ink-dim flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="includeZero"
              value="1"
              defaultChecked={includeZeroInventory}
              className="accent-good"
            />
            Include zero-inventory parts
          </label>

          <label className="text-ink-dim ml-auto flex items-center gap-2 text-xs">
            Rows
            <select name="pageSize" defaultValue={String(pageSize)} className="field px-2 py-1 font-mono text-xs">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>

          <Link
            href="/research"
            className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
          >
            Reset
          </Link>
        </div>
      </form>

      {error ? (
        <DatabaseError error={error} />
      ) : result && result.total === 0 ? (
        <EmptyState
          title={state === 'due' ? 'Nothing is due for research' : 'No MPNs match this queue view'}
          body={
            state === 'due'
              ? `No in-stock MPN is unresearched or older than ${staleDays} days under the current filters.`
              : 'Change the queue state or search terms to broaden the result.'
          }
          cta={{ href: '/opportunities', label: 'Open Market Opportunities' }}
        />
      ) : result ? (
        <>
          <div className="text-ink-faint mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <span>
              Showing {firstRow}–{lastRow} of {result.total}
            </span>
            <span>Never researched appears first; stale rows follow oldest-first.</span>
          </div>

          <ResearchQueueTable rows={rows} />

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-ink-faint font-mono text-xs">
              Page {result.page} of {Math.max(1, result.pages)}
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={hrefFor({ query, state, staleDays, includeZeroInventory, pageSize }, result.page - 1)}
                  className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">
                  ← Previous
                </span>
              )}
              {result.pages > 0 && result.page < result.pages ? (
                <Link
                  href={hrefFor({ query, state, staleDays, includeZeroInventory, pageSize }, result.page + 1)}
                  className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
                >
                  Next →
                </Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">
                  Next →
                </span>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
