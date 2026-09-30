import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PartDetailForm } from '@/components/part-detail-form'
import {
  AverageSoldPriceChart,
  PriceShippingChart,
  SoldHistoryChart,
  SoldUnitsHistoryChart,
  UnitsSoldChart,
  type HistoryPoint,
  type PeriodPoint,
} from '@/components/part-charts'
import { Chip, Notice, Panel, StatCard } from '@/components/ui'
import { getPartByMpn, researchSessionHistory } from '@/db/queries'
import { money, relativeTime } from '@/lib/format'
import { requireSession } from '@/lib/session'
import { timeTrend } from '@/lib/stats'
import {
  PERIOD_DAYS,
  PERIODS,
  PERIOD_LABELS,
  type MarketResearchSession,
  type Period,
} from '@/lib/types'

export const dynamic = 'force-dynamic'

const TABLE_PERIODS: Period[] = ['7d', '30d', '90d', '6m', '1yr']

export async function generateMetadata(props: { params: Promise<{ mpn: string }> }) {
  const { mpn } = await props.params
  return { title: `${decodeURIComponent(mpn)} — EbayDecisions` }
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
    const existing = byDay.get(day)
    if (!existing || atMs >= existing.atMs) {
      byDay.set(day, { atMs, point: { at: day, value } })
    }
  }

  return [...byDay.values()]
    .sort((a, b) => a.atMs - b.atMs)
    .map((entry) => entry.point)
}

function fullDate(iso: string | null | undefined): string {
  if (!iso) return 'Not researched'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Not researched'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function historyStatus(points: HistoryPoint[]) {
  const trend = timeTrend(points)
  if (trend.qualified) return { trend, label: 'Trend ready', tone: 'good' as const }
  if (trend.points < 2) return { trend, label: 'Need repeat research', tone: 'dim' as const }
  return {
    trend,
    label: `${trend.points} dates · ${Math.round(trend.spanDays)}d span`,
    tone: 'warn' as const,
  }
}

export default async function PartDetailPage(props: { params: Promise<{ mpn: string }> }) {
  await requireSession()

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw)
  const part = await getPartByMpn(mpn)

  if (!part) {
    notFound()
    throw new Error('Part not found')
  }

  const sessions = await researchSessionHistory(part.id, 100)
  const latest = sessions[0] ?? null
  const periods = latest?.periods ?? {}
  const thirty = periods['30d']
  const seven = periods['7d']
  const delivered30 =
    thirty?.price == null ? null : thirty.price + (thirty.shipping ?? 0)
  const velocity30 =
    thirty?.soldQty == null ? null : thirty.soldQty / PERIOD_DAYS['30d']

  const chartData: PeriodPoint[] = PERIODS.map((period) => {
    const observation = periods[period]
    const delivered =
      observation?.price == null
        ? null
        : observation.price + (observation.shipping ?? 0)

    return {
      period: PERIOD_LABELS[period]
        .replace('1 Year', '1Y')
        .replace('6 Months', '6M')
        .replace('90 Days', '90D')
        .replace('30 Days', '30D')
        .replace('7 Days', '7D'),
      daysAgo: PERIOD_DAYS[period],
      avgSoldPrice: observation?.price ?? null,
      avgShipping: observation?.shipping ?? null,
      delivered,
      soldQty: observation?.soldQty ?? null,
      soldPerDay:
        observation?.soldQty == null
          ? null
          : observation.soldQty / PERIOD_DAYS[period],
    }
  })

  const avgPriceHistory = collapseLatestPerDay(
    sessions,
    (session) => session.periods['30d']?.price,
  )
  const unitsHistory = collapseLatestPerDay(
    sessions,
    (session) => session.periods['30d']?.soldQty,
  )
  const priceHistoryStatus = historyStatus(avgPriceHistory)
  const unitsHistoryStatus = historyStatus(unitsHistory)

  const hasAveragePrice = chartData.some((point) => point.avgSoldPrice != null)
  const hasPriceShipping = chartData.some(
    (point) => point.avgSoldPrice != null || point.avgShipping != null,
  )
  const hasUnits = chartData.some((point) => point.soldQty != null)

  return (
    <div>
      <div className="mb-5">
        <Link
          href="/opportunities"
          className="text-ink-faint hover:text-ink mb-3 inline-block font-mono text-xs transition-colors"
        >
          ← Market Opportunities
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-ink text-lg font-semibold tracking-tight">
              <span className="text-info font-mono">{part.mpn}</span>
              <span className="text-ink-faint"> — </span>
              {part.description}
              <span className="text-ink-faint font-normal"> · Inventory: {part.inventoryQty}</span>
            </h1>
            <p className="text-ink-dim mt-1 text-sm">
              Last researched: {latest ? fullDate(latest.researchedAt) : 'Not researched'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Chip>{part.category}</Chip>
            {!part.active && <Chip tone="warn">Inactive</Chip>}
            <Link
              href={`/tracker?mpns=${encodeURIComponent(part.mpn)}`}
              className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs font-medium transition-colors"
            >
              {latest ? 'Update Research' : 'Research MPN'}
            </Link>
          </div>
        </div>
      </div>

      {!latest && (
        <div className="mb-5">
          <Notice tone="info">
            This MPN has no dated eBay Product Research session yet. Blank market values are intentional;
            nothing below is fabricated.
          </Notice>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="30D Avg Sold Price"
          value={money(thirty?.price)}
          sub={
            thirty?.price == null
              ? 'No 30d research yet'
              : `Avg ship ${money(thirty.shipping)} · delivered ${money(delivered30)}`
          }
          tone="info"
        />
        <StatCard
          label="30D Total Sold"
          value={thirty?.soldQty == null ? '—' : String(thirty.soldQty)}
          sub={velocity30 == null ? 'No 30d volume yet' : `${velocity30.toFixed(2)} sold/day`}
          tone={thirty?.soldQty == null ? 'neutral' : 'good'}
        />
        <StatCard
          label="7D Total Sold"
          value={seven?.soldQty == null ? '—' : String(seven.soldQty)}
          sub={
            seven?.soldQty == null
              ? 'No 7d volume yet'
              : `${(seven.soldQty / PERIOD_DAYS['7d']).toFixed(2)} sold/day`
          }
          tone={seven?.soldQty == null ? 'neutral' : 'good'}
        />
        <StatCard
          label="Research Freshness"
          value={latest ? relativeTime(latest.researchedAt) : 'Not researched'}
          sub={latest ? fullDate(latest.researchedAt) : 'Open Tracker to create the first session'}
          tone={latest ? 'info' : 'neutral'}
        />
      </div>

      <div className="mb-5">
        <Panel title="Current sold-market research" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 760 }}>
              <thead>
                <tr className="border-line border-b">
                  {[
                    'Period',
                    'Avg Sold Price',
                    'Avg Shipping',
                    'Delivered',
                    'Total Sold',
                    'Total Sellers',
                  ].map((header, index) => (
                    <th
                      key={header}
                      scope="col"
                      className={`text-ink-faint pb-2 text-xs font-medium tracking-widest uppercase ${
                        index === 0 ? 'text-left' : 'px-3 text-right'
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
                  const delivered =
                    observation?.price == null
                      ? null
                      : observation.price + (observation.shipping ?? 0)

                  return (
                    <tr key={period} className="border-line/50 border-b last:border-0">
                      <td className="text-ink-dim py-2 font-mono text-xs tracking-widest uppercase">
                        {PERIOD_LABELS[period]}
                      </td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs">
                        {money(observation?.price)}
                      </td>
                      <td className="text-ink-dim px-3 py-2 text-right font-mono text-xs">
                        {money(observation?.shipping)}
                      </td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs font-semibold">
                        {money(delivered)}
                      </td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs">
                        {observation?.soldQty ?? '—'}
                      </td>
                      <td className="text-ink-dim px-3 py-2 text-right font-mono text-xs">
                        {observation?.totalSellers ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-ink-faint mt-3 text-xs">
            These five values are nested eBay Product Research lookback windows from the latest dated
            session. They show the current cross-window shape; they are not calendar history.
          </p>
        </Panel>
      </div>

      <div className="mb-5 grid gap-4 xl:grid-cols-3">
        <Panel title="Average Sold Price by Lookback Window">
          {hasAveragePrice ? (
            <AverageSoldPriceChart data={chartData} />
          ) : (
            <p className="text-ink-dim py-16 text-center text-sm">
              No average sold-price values in the latest research session.
            </p>
          )}
        </Panel>

        <Panel title="Avg Sold Price vs Avg Shipping">
          {hasPriceShipping ? (
            <PriceShippingChart data={chartData} />
          ) : (
            <p className="text-ink-dim py-16 text-center text-sm">
              No sold-price or shipping values in the latest research session.
            </p>
          )}
        </Panel>

        <Panel title="Units Sold by Period">
          {hasUnits ? (
            <UnitsSoldChart data={chartData} />
          ) : (
            <p className="text-ink-dim py-16 text-center text-sm">
              No total-sold values in the latest research session.
            </p>
          )}
        </Panel>
      </div>

      <div className="mb-5">
        <div className="mb-3">
          <h2 className="text-ink text-sm font-semibold">Calendar history</h2>
          <p className="text-ink-dim mt-0.5 text-xs">
            Unlike the three charts above, these use repeated research dates. Same-day corrections
            collapse to the latest value for chart/trend math while the raw sessions remain stored.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Panel
            title="30D Avg Sold Price History"
            action={<Chip tone={priceHistoryStatus.tone}>{priceHistoryStatus.label}</Chip>}
          >
            {avgPriceHistory.length >= 2 ? (
              <SoldHistoryChart data={avgPriceHistory} />
            ) : (
              <p className="text-ink-dim py-16 text-center text-sm">
                Research this MPN on at least two different dates to draw calendar price history.
              </p>
            )}
          </Panel>

          <Panel
            title="30D Units Sold History"
            action={<Chip tone={unitsHistoryStatus.tone}>{unitsHistoryStatus.label}</Chip>}
          >
            {unitsHistory.length >= 2 ? (
              <SoldUnitsHistoryChart data={unitsHistory} />
            ) : (
              <p className="text-ink-dim py-16 text-center text-sm">
                Research this MPN on at least two different dates to draw calendar sold-volume history.
              </p>
            )}
          </Panel>
        </div>

        <p className="text-ink-faint mt-3 text-xs">
          A calendar trend becomes mature only after at least 3 distinct research dates spanning 14
          days. Before that, the charts are history context only.
        </p>
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
  )
}
