import { NextResponse } from 'next/server'

import { getSettings, listPartsWithMarket, loadTrendSummaries } from '@/db/queries'
import { decide } from '@/lib/decisions'
import { toCsv } from '@/lib/csv'
import { hasValidSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

/**
 * Full spreadsheet-friendly export. Sold lookback aggregates and point-in-time
 * active competition remain separate so downstream analysis cannot confuse
 * demand with supply.
 */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  const [settings, parts] = await Promise.all([
    getSettings(),
    listPartsWithMarket({ includeInactive: true }),
  ])
  const trends = await loadTrendSummaries(parts.map((part) => part.id))

  const header = [
    'mpn',
    'description',
    'category',
    'inventory_qty',
    'cost_basis',
    'ship_cost',
    'target_margin_pct',
    'source_url',
    'notes',
    'active',
    ...PERIODS.flatMap((period) => [
      `${period}_price`,
      `${period}_shipping`,
      `${period}_sold_qty`,
      `${period}_price_basis`,
      `${period}_source`,
      `${period}_captured_at`,
    ]),
    'active_asking_price',
    'active_asking_shipping',
    'active_listing_qty',
    'active_sample_size',
    'active_truncated',
    'active_captured_at',
    'sold_price_trend_pct_per_30d',
    'sold_price_trend_basis',
    'demand_trend_pct_per_30d',
    'demand_trend_basis',
    'supply_trend_pct_per_30d',
    'supply_trend_basis',
    'net_proceeds',
    'margin_dollars',
    'margin_pct',
    'suggested_list_price',
    'action',
    'reason',
  ]

  const rows = parts.map((part) => {
    const decision = decide(part, settings, trends.get(part.id))
    return [
      part.mpn,
      part.description,
      part.category,
      part.inventoryQty,
      part.costBasis,
      part.shipCost,
      part.targetMarginPct,
      part.sourceUrl,
      part.notes,
      part.active ? 'true' : 'false',
      ...PERIODS.flatMap((period) => {
        const observation = part.periods[period]
        return [
          observation?.price ?? null,
          observation?.shipping ?? null,
          observation?.soldQty ?? null,
          observation?.priceBasis ?? null,
          observation?.source ?? null,
          observation?.capturedAt ?? null,
        ]
      }),
      part.activeMarket?.askingPrice ?? null,
      part.activeMarket?.askingShipping ?? null,
      part.activeMarket?.activeQty ?? null,
      part.activeMarket?.sampleSize ?? null,
      part.activeMarket?.truncated ? 'true' : 'false',
      part.activeMarket?.capturedAt ?? null,
      decision.marketTrend.pctPer30d?.toFixed(2) ?? null,
      decision.marketTrend.basis,
      decision.demandTrend.pctPer30d?.toFixed(2) ?? null,
      decision.demandTrend.basis,
      decision.supplyTrend.pctPer30d?.toFixed(2) ?? null,
      decision.supplyTrend.basis,
      decision.economics?.netProceeds?.toFixed(2) ?? null,
      decision.economics?.marginDollars?.toFixed(2) ?? null,
      decision.economics?.marginPct?.toFixed(1) ?? null,
      decision.suggestedListPrice?.toFixed(2) ?? null,
      decision.action,
      decision.reason,
    ]
  })

  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(toCsv(header, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ebaydecisions-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
