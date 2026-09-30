import { MarketGrid, type GridRow } from '@/components/market-grid'
import { Notice, PageHeader } from '@/components/ui'
import { listPartsWithMarket } from '@/db/queries'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Tracker — EbayDecisions' }
export const dynamic = 'force-dynamic'

export default async function TrackerPage() {
  await requireSession()

  let rows: GridRow[] = []
  let error: string | null = null

  try {
    const parts = await listPartsWithMarket()
    rows = parts.map((part) => ({
      partId: part.id,
      mpn: part.mpn,
      description: part.description,
      inventoryQty: part.inventoryQty,
      periods: part.periods,
    }))
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  return (
    <div>
      <PageHeader
        title="Market Tracker"
        subtitle="Comps per lookback window. Every edit is kept as history, so trends are real rather than a snapshot."
      />

      {error ? (
        <Notice tone="bad">Could not load the tracker: {error}</Notice>
      ) : (
        <>
          <div className="mb-4">
            <Notice tone="info">
              Windows run 1 year → 7 days, oldest to newest, which is the direction the trend math
              and charts read. eBay&apos;s sold-comp history only reaches back 90 days, so the
              6-month and 1-year windows fill in by hand or accumulate as this app keeps running.
            </Notice>
          </div>
          <MarketGrid rows={rows} />
        </>
      )}
    </div>
  )
}
