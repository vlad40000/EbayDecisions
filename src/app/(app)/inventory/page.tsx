import { AddPartForm } from '@/components/add-part-form'
import { PartsTable, type PartsTableRow } from '@/components/parts-table'
import { Notice, PageHeader } from '@/components/ui'
import { getSettings, listPartsWithMarket } from '@/db/queries'
import { requireSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

export const metadata = { title: 'Inventory — EbayDecisions' }
export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  await requireSession()

  let rows: PartsTableRow[] = []
  let defaultShipCost = 12
  let defaultTargetMarginPct = 35
  let error: string | null = null

  try {
    const [settings, parts] = await Promise.all([getSettings(), listPartsWithMarket()])
    defaultShipCost = settings.defaultShipCost
    defaultTargetMarginPct = settings.targetMarginPct

    rows = parts.map((part) => {
      // Newest window that actually has a price, for at-a-glance context.
      let marketTotal: number | null = null
      for (let i = PERIODS.length - 1; i >= 0; i -= 1) {
        const observation = part.periods[PERIODS[i] as (typeof PERIODS)[number]]
        if (observation?.price != null) {
          marketTotal = observation.price + (observation.shipping ?? 0)
          break
        }
      }

      return {
        partId: part.id,
        mpn: part.mpn,
        description: part.description,
        category: part.category,
        inventoryQty: part.inventoryQty,
        costBasis: part.costBasis,
        shipCost: part.shipCost,
        targetMarginPct: part.targetMarginPct,
        sourceUrl: part.sourceUrl,
        marketTotal,
      }
    })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="What you hold and what it cost you. Cost basis is what makes the decision engine work."
        action={<AddPartForm />}
      />

      {error ? (
        <Notice tone="bad">Could not load inventory: {error}</Notice>
      ) : (
        <PartsTable
          rows={rows}
          defaultShipCost={defaultShipCost}
          defaultTargetMarginPct={defaultTargetMarginPct}
        />
      )}
    </div>
  )
}
