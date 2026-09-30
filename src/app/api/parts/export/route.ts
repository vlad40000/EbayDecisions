import { NextResponse } from 'next/server'

import { getSettings, listPartsWithMarket } from '@/db/queries'
import { decide } from '@/lib/decisions'
import { toCsv } from '@/lib/csv'
import { hasValidSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

/**
 * Full export: the catalogue, the latest reading for every window, and the
 * computed decision. One row per part, so it drops straight into a spreadsheet.
 */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  const [settings, parts] = await Promise.all([getSettings(), listPartsWithMarket({ includeInactive: true })])

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
      `${period}_qty`,
      `${period}_source`,
    ]),
    'net_proceeds',
    'margin_dollars',
    'margin_pct',
    'suggested_list_price',
    'action',
    'reason',
  ]

  const rows = parts.map((part) => {
    const decision = decide(part, settings)
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
          observation?.qty ?? null,
          observation?.source ?? null,
        ]
      }),
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
