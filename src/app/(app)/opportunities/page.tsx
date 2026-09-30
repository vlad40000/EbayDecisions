import Link from 'next/link'

import { Chip, DatabaseError, EmptyState, PageHeader } from '@/components/ui'
import {
  listMarketOpportunities,
  type MarketOpportunityOptions,
  type MarketOpportunityResearchState,
  type MarketOpportunitySort,
} from '@/db/queries'
import { money, relativeTime } from '@/lib/format'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Market Opportunities — EbayDecisions' }
export const dynamic = 'force-dynamic'

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>

const SORTS = new Set<MarketOpportunitySort>([
  'mpn',
  'inventory',
  '7d',
  '30d',
  '90d',
  '6m',
  '1yr',
  'avg-sold',
  'avg-ship',
  'updated',
])

const RESEARCH_STATES = new Set<MarketOpportunityResearchState>([
  'all',
  'never',
  'stale',
  'current',
])

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function numberParam(
  value: string | string[] | undefined,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number | null {
  const raw = first(value)
  if (raw == null || raw.trim() === '') return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  let result = options.integer ? Math.trunc(parsed) : parsed
  if (options.min != null) result = Math.max(options.min, result)
  if (options.max != null) result = Math.min(options.max, result)
  return result
}

function buildHref(options: MarketOpportunityOptions, patch: Partial<MarketOpportunityOptions>): string {
  const next = { ...options, ...patch }
  const params = new URLSearchParams()

  if (next.query) params.set('q', next.query)
  if (next.inStock) params.set('inStock', '1')
  if (next.research && next.research !== 'all') params.set('research', next.research)
  if (next.staleDays != null) params.set('staleDays', String(next.staleDays))
  if (next.min30dSold != null) params.set('min30d', String(next.min30dSold))
  if (next.minAvgSold != null) params.set('minAvgSold', String(next.minAvgSold))
  if (next.minInventory != null) params.set('minInventory', String(next.minInventory))
  if (next.sort) params.set('sort', next.sort)
  if (next.direction) params.set('direction', next.direction)
  if (next.page && next.page > 1) params.set('page', String(next.page))
  if (next.pageSize && next.pageSize !== 50) params.set('pageSize', String(next.pageSize))

  const query = params.toString()
  return query ? `/opportunities?${query}` : '/opportunities'
}

function researchStatus(lastResearchedAt: string | null, staleDays: number) {
  if (!lastResearchedAt) return { label: 'Not researched', tone: 'dim' as const }
  const ageDays = Math.floor((Date.now() - new Date(lastResearchedAt).getTime()) / 86_400_000)
  if (ageDays > staleDays) return { label: 'Stale', tone: 'warn' as const }
  return { label: 'Current', tone: 'good' as const }
}

export default async function OpportunitiesPage(props: { searchParams: PageSearchParams }) {
  await requireSession()

  const params = await props.searchParams
  const requestedSort = first(params.sort)
  const requestedResearch = first(params.research)
  const requestedDirection = first(params.direction)

  const options: MarketOpportunityOptions = {
    query: first(params.q)?.trim() || undefined,
    inStock: first(params.inStock) === '1',
    research:
      requestedResearch && RESEARCH_STATES.has(requestedResearch as MarketOpportunityResearchState)
        ? (requestedResearch as MarketOpportunityResearchState)
        : 'all',
    staleDays: numberParam(params.staleDays, { min: 1, max: 3650, integer: true }) ?? 30,
    min30dSold: numberParam(params.min30d, { min: 0, integer: true }),
    minAvgSold: numberParam(params.minAvgSold, { min: 0 }),
    minInventory: numberParam(params.minInventory, { min: 0, integer: true }),
    sort:
      requestedSort && SORTS.has(requestedSort as MarketOpportunitySort)
        ? (requestedSort as MarketOpportunitySort)
        : 'updated',
    direction: requestedDirection === 'asc' ? 'asc' : 'desc',
    page: numberParam(params.page, { min: 1, integer: true }) ?? 1,
    pageSize: numberParam(params.pageSize, { min: 1, max: 100, integer: true }) ?? 50,
  }

  let result: Awaited<ReturnType<typeof listMarketOpportunities>> | null = null
  let error: string | null = null

  try {
    result = await listMarketOpportunities(options)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const staleDays = options.staleDays ?? 30
  const rows = result?.rows ?? []
  const firstRow = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRow = result ? Math.min(result.page * result.pageSize, result.total) : 0

  const sortHeader = (label: string, key: MarketOpportunitySort, align: 'left' | 'right' = 'right') => {
    const active = options.sort === key
    const nextDirection =
      active ? (options.direction === 'asc' ? 'desc' : 'asc') : key === 'mpn' ? 'asc' : 'desc'
    const glyph = active ? (options.direction === 'asc' ? ' ↑' : ' ↓') : ''

    return (
      <th
        scope="col"
        className={`text-ink-faint px-2 py-2 text-xs font-medium tracking-widest uppercase ${
          align === 'left' ? 'text-left' : 'text-right'
        }`}
      >
        <Link
          href={buildHref(options, { sort: key, direction: nextDirection, page: 1 })}
          className="hover:text-ink whitespace-nowrap transition-colors"
        >
          {label}
          {glyph}
        </Link>
      </th>
    )
  }

  return (
    <div>
      <PageHeader
        title="Market Opportunities"
        subtitle="Use real eBay SOLD research to narrow a large parts catalogue to the MPNs worth your time."
      />

      <form
        action="/opportunities"
        method="get"
        className="bg-surface border-line mb-4 rounded border p-4"
      >
        <input type="hidden" name="sort" value={options.sort} />
        <input type="hidden" name="direction" value={options.direction} />

        <div className="grid gap-3 lg:grid-cols-[minmax(260px,2fr)_repeat(5,minmax(110px,1fr))]">
          <label className="block">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Search MPN / Description
            </span>
            <input
              name="q"
              defaultValue={options.query ?? ''}
              placeholder="W10830046 or control board"
              className="field w-full px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Research
            </span>
            <select
              name="research"
              defaultValue={options.research}
              className="field w-full px-2 py-2 text-sm"
            >
              <option value="all">All</option>
              <option value="never">Never researched</option>
              <option value="stale">Stale</option>
              <option value="current">Current</option>
            </select>
          </label>

          <label className="block">
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

          <label className="block">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              30d sold ≥
            </span>
            <input
              type="number"
              name="min30d"
              min="0"
              defaultValue={options.min30dSold ?? ''}
              className="field w-full px-2 py-2 text-right font-mono text-sm"
            />
          </label>

          <label className="block">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Avg sold ≥ $
            </span>
            <input
              type="number"
              name="minAvgSold"
              min="0"
              step="0.01"
              defaultValue={options.minAvgSold ?? ''}
              className="field w-full px-2 py-2 text-right font-mono text-sm"
            />
          </label>

          <label className="block">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Inventory ≥
            </span>
            <input
              type="number"
              name="minInventory"
              min="0"
              defaultValue={options.minInventory ?? ''}
              className="field w-full px-2 py-2 text-right font-mono text-sm"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-ink-dim flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="inStock"
              value="1"
              defaultChecked={options.inStock}
              className="accent-good"
            />
            In stock only
          </label>

          <label className="text-ink-dim ml-auto flex items-center gap-2 text-xs">
            Rows
            <select
              name="pageSize"
              defaultValue={String(options.pageSize)}
              className="field px-2 py-1 font-mono text-xs"
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>

          <Link
            href="/opportunities"
            className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
          >
            Reset
          </Link>
          <button
            type="submit"
            className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            Apply filters
          </button>
        </div>
      </form>

      {error ? (
        <DatabaseError error={error} />
      ) : result && result.total === 0 ? (
        <EmptyState
          title="No parts match these filters"
          body="Blank market data is intentional. Broaden the filters, or research an MPN to create its first dated SOLD-market session."
          cta={{ href: '/tracker', label: 'Open Market Tracker' }}
        />
      ) : result ? (
        <>
          <div className="text-ink-faint mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <span>
              Showing {firstRow}–{lastRow} of {result.total} matching MPNs
            </span>
            <span>
              30d Avg Sold / Avg Ship columns use the latest dated research session
            </span>
          </div>

          <div className="bg-surface border-line overflow-hidden rounded border">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" style={{ minWidth: 1180 }}>
                <thead className="bg-surface-2">
                  <tr className="border-line border-b">
                    {sortHeader('MPN', 'mpn', 'left')}
                    {sortHeader('Inv', 'inventory')}
                    <th
                      scope="col"
                      className="text-ink-faint px-2 py-2 text-left text-xs font-medium tracking-widest uppercase"
                    >
                      Description
                    </th>
                    {sortHeader('7d', '7d')}
                    {sortHeader('30d', '30d')}
                    {sortHeader('90d', '90d')}
                    {sortHeader('6m', '6m')}
                    {sortHeader('1y', '1yr')}
                    {sortHeader('Avg Sold', 'avg-sold')}
                    {sortHeader('Avg Ship', 'avg-ship')}
                    <th
                      scope="col"
                      className="text-ink-faint px-2 py-2 text-right text-xs font-medium tracking-widest uppercase"
                    >
                      Delivered
                    </th>
                    {sortHeader('Updated', 'updated', 'left')}
                    <th
                      scope="col"
                      className="text-ink-faint px-2 py-2 text-right text-xs font-medium tracking-widest uppercase"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const status = researchStatus(row.lastResearchedAt, staleDays)
                    const delivered =
                      row.avgSoldPrice == null
                        ? null
                        : row.avgSoldPrice + (row.avgShipping ?? 0)

                    return (
                      <tr key={row.partId} className="border-line/60 border-b last:border-0">
                        <td className="px-2 py-2">
                          <Link
                            href={`/inventory/${encodeURIComponent(row.mpn)}`}
                            className="text-info hover:text-good font-mono text-xs font-semibold transition-colors"
                          >
                            {row.mpn}
                          </Link>
                        </td>
                        <td className="text-ink px-2 py-2 text-right font-mono text-xs">
                          {row.inventoryQty}
                        </td>
                        <td className="text-ink-dim max-w-[300px] truncate px-2 py-2 text-xs">
                          {row.description}
                        </td>
                        {[row.sold7d, row.sold30d, row.sold90d, row.sold6m, row.sold1yr].map(
                          (value, index) => (
                            <td
                              key={index}
                              className="text-ink px-2 py-2 text-right font-mono text-xs"
                            >
                              {value ?? '—'}
                            </td>
                          ),
                        )}
                        <td className="text-ink px-2 py-2 text-right font-mono text-xs">
                          {money(row.avgSoldPrice)}
                        </td>
                        <td className="text-ink-dim px-2 py-2 text-right font-mono text-xs">
                          {money(row.avgShipping)}
                        </td>
                        <td className="text-ink px-2 py-2 text-right font-mono text-xs font-semibold">
                          {money(delivered)}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <Chip tone={status.tone}>{status.label}</Chip>
                            <span className="text-ink-faint font-mono text-[10px] whitespace-nowrap">
                              {row.lastResearchedAt ? relativeTime(row.lastResearchedAt) : '—'}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <Link
                              href={`/tracker?mpn=${encodeURIComponent(row.mpn)}`}
                              className="text-good hover:text-ink text-xs transition-colors"
                            >
                              {row.lastResearchedAt ? 'Update Research' : 'Research'}
                            </Link>
                            <Link
                              href={`/inventory/${encodeURIComponent(row.mpn)}`}
                              className="text-ink-faint hover:text-info text-xs transition-colors"
                            >
                              History
                            </Link>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-ink-faint font-mono text-xs">
              Page {result.page} of {Math.max(1, result.pages)}
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={buildHref(options, { page: result.page - 1 })}
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
                  href={buildHref(options, { page: result.page + 1 })}
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
