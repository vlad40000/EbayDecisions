import Link from 'next/link'

import { AddPartForm } from '@/components/add-part-form'
import { PartsTable, type PartsTableRow } from '@/components/parts-table'
import { DatabaseError, PageHeader } from '@/components/ui'
import { listInventoryParts } from '@/db/queries'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Inventory — EbayDecisions' }
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
  query?: string
  includeInactive: boolean
  pageSize: number
}, page: number) {
  const params = new URLSearchParams()
  if (input.query) params.set('q', input.query)
  if (input.includeInactive) params.set('inactive', '1')
  if (input.pageSize !== 50) params.set('pageSize', String(input.pageSize))
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/inventory?${query}` : '/inventory'
}

export default async function InventoryPage(props: { searchParams: PageSearchParams }) {
  await requireSession()

  const params = await props.searchParams
  const query = first(params.q)?.trim() || undefined
  const includeInactive = first(params.inactive) === '1'
  const page = intParam(params.page, 1, 1, 1_000_000)
  const pageSize = intParam(params.pageSize, 50, 1, 100)

  let result: Awaited<ReturnType<typeof listInventoryParts>> | null = null
  let error: string | null = null

  try {
    result = await listInventoryParts({ query, includeInactive, page, pageSize })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const rows: PartsTableRow[] = (result?.rows ?? []).map((part) => ({
    partId: part.id,
    mpn: part.mpn,
    description: part.description,
    category: part.category,
    inventoryQty: part.inventoryQty,
    sourceUrl: part.sourceUrl,
    active: part.active,
  }))

  const firstRow = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRow = result ? Math.min(result.page * result.pageSize, result.total) : 0

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Inventory context for research: MPN, description, category, and quantity on hand."
        action={<AddPartForm />}
      />

      <form action="/inventory" method="get" className="bg-surface border-line mb-4 rounded border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[280px] flex-1">
            <span className="text-ink-faint mb-1 block text-[10px] tracking-widest uppercase">
              Search MPN / Description
            </span>
            <input
              name="q"
              defaultValue={query ?? ''}
              placeholder="W10830046 or control board"
              className="field w-full px-3 py-2 text-sm"
            />
          </label>

          <label className="text-ink-dim flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="inactive"
              value="1"
              defaultChecked={includeInactive}
              className="accent-good"
            />
            Include inactive
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
            href="/inventory"
            className="border-line text-ink-dim hover:text-ink rounded border px-3 py-2 text-xs transition-colors"
          >
            Reset
          </Link>
        </div>
      </form>

      {error ? (
        <DatabaseError error={error} />
      ) : result ? (
        <>
          <div className="text-ink-faint mb-2 font-mono text-xs">
            Showing {firstRow}–{lastRow} of {result.total} MPNs
          </div>

          <PartsTable rows={rows} />

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-ink-faint font-mono text-xs">
              Page {result.page} of {Math.max(1, result.pages)}
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={pageHref({ query, includeInactive, pageSize }, result.page - 1)}
                  className="border-line text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="border-line text-ink-ghost rounded border px-3 py-1.5 text-xs">← Previous</span>
              )}

              {result.pages > 0 && result.page < result.pages ? (
                <Link
                  href={pageHref({ query, includeInactive, pageSize }, result.page + 1)}
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
