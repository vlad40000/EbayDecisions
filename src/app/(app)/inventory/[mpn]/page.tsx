import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PartDetailForm } from '@/components/part-detail-form'
import {
  DeliveredCostChart,
  PriceShippingChart,
  SoldHistoryChart,
  SoldUnitsHistoryChart,
  UnitsSoldChart,
  type HistoryPoint,
  type PeriodPoint,
} from '@/components/part-charts'
import { Panel, StatCard } from '@/components/ui'
import { getPartByMpn, researchSessionHistory } from '@/db/queries'
import { money } from '@/lib/format'
import { requireSession } from '@/lib/session'
import { timeTrend } from '@/lib/stats'
import { PERIOD_DAYS, PERIOD_LABELS, type MarketResearchSession, type Period } from '@/lib/types'

export const dynamic = 'force-dynamic'

const TABLE_PERIODS: Period[] = ['1yr', '6m', '90d', '30d', '7d']

export async function generateMetadata(props: { params: Promise<{ mpn: string }> }) {
  const { mpn } = await props.params
  return { title: `${decodeURIComponent(mpn)} — Dashboard` }
}

function collapseLatestPerDay(
  sessions: MarketResearchSession[],
  valueFor: (session: MarketResearchSession) => number | null | undefined,
): HistoryPoint[] {
  const byDay = new Map<string, { atMs: number; point: HistoryPoint }>()
  for (const session of sessions) {
    const value = valueFor(session)
    if (value == null || !Number.isFinite(value)) continue
    const atMs = new Date(session.researchedAt).getTime()
    if (!Number.isFinite(atMs)) continue
    const day = new Date(atMs).toISOString().slice(0, 10)
    const current = byDay.get(day)
    if (!current || atMs >= current.atMs) byDay.set(day, { atMs, point: { at: day, value } })
  }
  return [...byDay.values()].sort((a, b) => a.atMs - b.atMs).map((entry) => entry.point)
}

function delivered(price: number | null | undefined, shipping: number | null | undefined) {
  return price == null ? null : price + (shipping ?? 0)
}

export default async function PartDetailPage(props: { params: Promise<{ mpn: string }> }) {
  await requireSession()

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw)
  const part = await getPartByMpn(mpn)
  if (!part) notFound()

  const sessions = await researchSessionHistory(part.id, 100)
  const latest = sessions[0] ?? null
  const periods = latest?.periods ?? {}
  const seven = periods['7d']
  const oneYear = periods['1yr']
  const sevenCost = delivered(seven?.price, seven?.shipping)
  const yearCost = delivered(oneYear?.price, oneYear?.shipping)

  let trendLabel = '—'
  let trendSub = 'Need 7d and 1yr price'
  if (sevenCost != null && yearCost != null) {
    const delta = sevenCost - yearCost
    trendLabel = Math.abs(delta) < 0.01 ? 'Flat' : delta > 0 ? 'Rising' : 'Falling'
    trendSub = `${delta >= 0 ? '+' : ''}${money(delta)} vs 1yr`
  }

  const chartData: PeriodPoint[] = TABLE_PERIODS.map((period) => {
    const observation = periods[period]
    return {
      period: PERIOD_LABELS[period],
      daysAgo: PERIOD_DAYS[period],
      avgSoldPrice: observation?.price ?? null,
      avgShipping: observation?.shipping ?? null,
      delivered: delivered(observation?.price, observation?.shipping),
      soldQty: observation?.soldQty ?? null,
    }
  })

  const avgPriceHistory = collapseLatestPerDay(sessions, (session) => session.periods['30d']?.price)
  const unitsHistory = collapseLatestPerDay(sessions, (session) => session.periods['30d']?.soldQty)
  const priceTrend = timeTrend(avgPriceHistory)
  const unitsTrend = timeTrend(unitsHistory)

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/tracker" className="text-ink-faint hover:text-ink font-mono text-xs">← Market Tracker</Link>
          <h1 className="text-ink mt-2 text-lg font-semibold">
            <span className="text-info font-mono">{part.mpn}</span>
            <span className="text-ink-faint"> — </span>
            {part.description}
          </h1>
          <p className="text-ink-faint mt-1 font-mono text-xs">
            Inventory: {part.inventoryQty} unit{part.inventoryQty === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          href={`/tracker?mpns=${encodeURIComponent(part.mpn)}`}
          className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs"
        >
          Update Research
        </Link>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="7D Total Cost" value={money(sevenCost)} />
        <StatCard label="1YR Total Cost" value={money(yearCost)} />
        <StatCard label="7D Sold" value={seven?.soldQty == null ? '—' : String(seven.soldQty)} />
        <StatCard
          label="Cost Trend"
          value={trendLabel}
          sub={trendSub}
          tone={trendLabel === 'Falling' ? 'good' : trendLabel === 'Rising' ? 'warn' : 'neutral'}
        />
      </div>

      <div className="border-line bg-surface mb-5 overflow-hidden rounded border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-line bg-surface-2 border-b">
              {['Period', 'Price', 'Shipping', 'Total Cost', 'Qty'].map((header, index) => (
                <th
                  key={header}
                  className={`text-ink-faint px-4 py-3 text-xs font-medium tracking-widest uppercase ${
                    index === 0 ? 'text-left' : 'text-right'
                  }`}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TABLE_PERIODS.map((period) => {
              const observation = periods[period]
              const total = delivered(observation?.price, observation?.shipping)
              return (
                <tr key={period} className="border-line border-b last:border-0">
                  <td className="text-ink-dim px-4 py-3 font-mono text-xs tracking-wider uppercase">{PERIOD_LABELS[period]}</td>
                  <td className="text-ink px-4 py-3 text-right font-mono">{money(observation?.price)}</td>
                  <td className="text-ink px-4 py-3 text-right font-mono">{money(observation?.shipping)}</td>
                  <td className="text-good px-4 py-3 text-right font-mono font-semibold">{money(total)}</td>
                  <td className="text-ink px-4 py-3 text-right font-mono">{observation?.soldQty ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mb-5 grid gap-4 xl:grid-cols-3">
        <Panel title="Total Cost Over Time"><DeliveredCostChart data={chartData} /></Panel>
        <Panel title="Price vs. Shipping"><PriceShippingChart data={chartData} /></Panel>
        <Panel title="Market Quantity"><UnitsSoldChart data={chartData} /></Panel>
      </div>

      <details className="border-line bg-surface rounded border">
        <summary className="text-ink-dim hover:text-ink cursor-pointer px-4 py-3 text-sm font-medium">
          More details — history, advanced metrics, part settings
        </summary>
        <div className="border-line border-t p-4">
          <div className="mb-5 grid gap-4 xl:grid-cols-2">
            <Panel title="30D Avg Sold Price History">
              {avgPriceHistory.length >= 2 ? (
                <SoldHistoryChart data={avgPriceHistory} />
              ) : (
                <p className="text-ink-dim py-12 text-center text-sm">Need at least two research dates.</p>
              )}
              <p className="text-ink-faint mt-2 text-xs">
                {priceTrend.qualified ? 'Trend ready.' : 'History stays available until enough dates exist for a mature trend.'}
              </p>
            </Panel>
            <Panel title="30D Units Sold History">
              {unitsHistory.length >= 2 ? (
                <SoldUnitsHistoryChart data={unitsHistory} />
              ) : (
                <p className="text-ink-dim py-12 text-center text-sm">Need at least two research dates.</p>
              )}
              <p className="text-ink-faint mt-2 text-xs">
                {unitsTrend.qualified ? 'Trend ready.' : 'History stays available until enough dates exist for a mature trend.'}
              </p>
            </Panel>
          </div>

          <PartDetailForm
            partId={part.id}
            description={part.description}
            category={part.category}
            notes={part.notes}
            sourceUrl={part.sourceUrl}
            active={part.active}
          />
        </div>
      </details>
    </div>
  )
}
