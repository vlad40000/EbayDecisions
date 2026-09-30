import { MarketGrid, type GridRow } from '@/components/market-grid'
import { DatabaseError, Notice, PageHeader } from '@/components/ui'
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
      activeMarket: part.activeMarket,
    }))
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  return (
    <div>
      <PageHeader
        title="Market Tracker"
        subtitle="Sold-market lookback windows plus point-in-time active competition. Manual edits stay local until Save MPN."
      />

      {error ? (
        <DatabaseError error={error} />
      ) : (
        <>
          <div className="mb-4">
            <Notice tone="info">
              Sold counts belong to the 1-year → 7-day lookback windows. Active listing count is a
              separate point-in-time capture. Historical trends only become actionable after at least
              three distinct capture dates spanning 14 days; same-day corrections remain in the audit
              trail but collapse to the latest reading for trend math.
            </Notice>
          </div>
          <MarketGrid rows={rows} />
        </>
      )}
    </div>
  )
}
