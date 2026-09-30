import { MarketGrid, type GridRow } from '@/components/market-grid'
import { DatabaseError, Notice, PageHeader } from '@/components/ui'
import { listPartsWithMarket, listPartsWithMarketForMpns } from '@/db/queries'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Tracker — EbayDecisions' }
export const dynamic = 'force-dynamic'

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function TrackerPage(props: { searchParams: PageSearchParams }) {
  await requireSession()

  const searchParams = await props.searchParams
  const requested = (first(searchParams.mpns) ?? '')
    .split(',')
    .map((mpn) => mpn.trim())
    .filter(Boolean)
    .slice(0, 20)

  let rows: GridRow[] = []
  let error: string | null = null

  try {
    const parts =
      requested.length > 0
        ? await listPartsWithMarketForMpns(requested)
        : await listPartsWithMarket()

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
        subtitle={
          requested.length > 0
            ? `Working research set · ${rows.length} of ${requested.length} selected MPNs found`
            : 'Sold-market lookback windows plus point-in-time active competition. Manual edits stay local until Save MPN.'
        }
      />

      {error ? (
        <DatabaseError error={error} />
      ) : (
        <>
          <div className="mb-4">
            <Notice tone="info">
              {requested.length > 0
                ? 'This is the local working set selected in Research Queue. No batch eBay calls were made. The next Tracker phase will replace this legacy editor with explicit SAVE RESEARCH sessions.'
                : 'Sold counts belong to the 1-year → 7-day lookback windows. Active listing count is a separate point-in-time capture. Historical trends only become actionable after at least three distinct capture dates spanning 14 days; same-day corrections remain in the audit trail but collapse to the latest reading for trend math.'}
            </Notice>
          </div>
          <MarketGrid rows={rows} />
        </>
      )}
    </div>
  )
}
