import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PartDetailForm } from '@/components/part-detail-form'
import {
  ActiveSupplyHistoryChart,
  PriceShippingChart,
  SoldHistoryChart,
  SoldVelocityChart,
  WindowCurveChart,
  type HistoryPoint,
  type PeriodPoint,
} from '@/components/part-charts'
import { ActionBadge, Chip, Notice, Panel, SourceBadge, StatCard } from '@/components/ui'
import {
  activeSnapshotHistory,
  getPartWithMarket,
  getSettings,
  loadTrendSummaries,
  snapshotHistory,
} from '@/db/queries'
import { decide } from '@/lib/decisions'
import { money, percent, relativeTime, signedPercent, toNumber } from '@/lib/format'
import { requireSession } from '@/lib/session'
import { spacedWindowTrend, trendValueAtX } from '@/lib/stats'
import {
  PERIOD_DAYS,
  PERIODS,
  PERIOD_LABELS,
  PRICE_BASIS_LABELS,
  type Period,
} from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: { params: Promise<{ mpn: string }> }) {
  const { mpn } = await props.params
  return { title: `${decodeURIComponent(mpn)} — EbayDecisions` }
}

function collapseLatestPerDay(
  rows: { at: Date; value: number | null }[],
): HistoryPoint[] {
  const byDay = new Map<string, { atMs: number; point: HistoryPoint }>()
  for (const row of rows) {
    if (row.value == null || !Number.isFinite(row.value)) continue
    const atMs = row.at.getTime()
    const day = row.at.toISOString().slice(0, 10)
    const existing = byDay.get(day)
    if (!existing || atMs >= existing.atMs) byDay.set(day, { atMs, point: { at: day, value: row.value } })
  }
  return [...byDay.values()]
    .sort((a, b) => a.atMs - b.atMs)
    .map((entry) => entry.point)
}

export default async function PartDetailPage(props: { params: Promise<{ mpn: string }> }) {
  await requireSession()

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw)
  const [settings, loadedPart] = await Promise.all([getSettings(), getPartWithMarket(mpn)])
  if (!loadedPart) {
    notFound()
    throw new Error('Part not found')
  }
  const part = loadedPart

  const [marketRows, activeRows, summaries] = await Promise.all([
    snapshotHistory(part.id),
    activeSnapshotHistory(part.id),
    loadTrendSummaries([part.id]),
  ])
  const summary = summaries.get(part.id)
  const decision = decide(part, settings, summary)

  const windowFit = spacedWindowTrend(
    PERIODS.map((period) => ({
      daysAgo: PERIOD_DAYS[period],
      value:
        part.periods[period]?.price == null
          ? null
          : part.periods[period]!.price! + (part.periods[period]!.shipping ?? 0),
    })),
  )
  const fitInput = PERIODS.map((period) => ({
    x: -PERIOD_DAYS[period],
    value:
      part.periods[period]?.price == null
        ? null
        : part.periods[period]!.price! + (part.periods[period]!.shipping ?? 0),
  }))

  const chartData: PeriodPoint[] = PERIODS.map((period) => {
    const observation = part.periods[period]
    const totalCost =
      observation?.price == null ? null : observation.price + (observation.shipping ?? 0)
    return {
      period: PERIOD_LABELS[period],
      daysAgo: PERIOD_DAYS[period],
      totalCost,
      trend: trendValueAtX(fitInput, windowFit, -PERIOD_DAYS[period]),
      price: observation?.price ?? null,
      shipping: observation?.shipping ?? null,
      soldQty: observation?.soldQty ?? null,
      soldPerDay:
        observation?.soldQty == null ? null : observation.soldQty / PERIOD_DAYS[period],
    }
  })

  const historyPeriod: Period = summary?.marketPeriod ?? '30d'
  const soldHistory = collapseLatestPerDay(
    marketRows
      .filter((row) => row.period === historyPeriod && row.priceBasis === 'sold')
      .map((row) => ({
        at: row.capturedAt,
        value:
          toNumber(row.price) == null
            ? null
            : (toNumber(row.price) as number) + (toNumber(row.shipping) ?? 0),
      })),
  )
  const supplyHistory = collapseLatestPerDay(
    activeRows.map((row) => ({ at: row.capturedAt, value: row.activeQty })),
  )

  const economics = decision.economics
  const hasWindowData = chartData.some((point) => point.totalCost != null || point.soldQty != null)
  const active = part.activeMarket

  return (
    <div>
      <div className="mb-6">
        <Link href="/inventory" className="text-ink-faint hover:text-ink mb-3 inline-block font-mono text-xs transition-colors">
          ← Inventory
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-info font-mono text-lg font-semibold">{part.mpn}</h1>
            <p className="text-ink mt-0.5 text-sm">{part.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip>{part.category}</Chip>
              <Chip tone={part.inventoryQty > 1 ? 'good' : 'dim'}>{part.inventoryQty} on hand</Chip>
              {!part.active && <Chip tone="warn">Inactive</Chip>}
              {part.sourceUrl && (
                <a href={part.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-ink-faint hover:text-info font-mono text-xs transition-colors">
                  reference ↗
                </a>
              )}
            </div>
          </div>
          <ActionBadge action={decision.action} />
        </div>
      </div>

      <div className="mb-6">
        <Panel title="Recommendation">
          <p className="text-ink text-sm">{decision.reason}</p>
          {decision.notes.length > 0 && (
            <ul className="text-ink-dim mt-2 space-y-0.5 text-xs">
              {decision.notes.map((note) => <li key={note}>· {note}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {decision.suggestedListPrice != null && (
              <Chip tone="info">Target {decision.targetMarginPct.toFixed(0)}% margin at {money(decision.suggestedListPrice)} + {money(economics?.shipping ?? 0)} shipping</Chip>
            )}
            <Chip tone={decision.provenance === 'sold' ? 'good' : decision.provenance === 'asking' ? 'warn' : 'dim'}>
              price basis: {decision.provenance}
            </Chip>
          </div>
        </Panel>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Buyer pays"
          value={money(economics?.grossOrder)}
          sub={economics ? `${money(economics.price)} + ${money(economics.shipping)} ship` : 'No market price yet'}
          hint="Item price plus buyer-paid shipping. The eBay percentage fee is modeled on this order total."
        />
        <StatCard
          label="You net"
          value={money(economics?.netProceeds)}
          sub={economics ? `after ${money(economics.fees)} fees, ${money(economics.shipCost)} ship` : undefined}
          hint={`Fee model: ${settings.feePct}% of the order plus ${money(settings.feeFixed)} fixed.`}
        />
        <StatCard
          label="Margin"
          value={money(economics?.marginDollars)}
          sub={economics?.marginPct != null ? `${percent(economics.marginPct)}${economics.roiPct != null ? ` · ${percent(economics.roiPct, 0)} ROI` : ''}` : part.costBasis == null ? 'Set a cost basis' : undefined}
          tone={economics?.marginDollars == null ? 'neutral' : economics.marginDollars < 0 ? 'bad' : 'good'}
        />
        <StatCard
          label="Sold-price trend"
          value={decision.marketTrend.direction === 'unknown' ? 'Not qualified' : decision.marketTrend.direction === 'flat' ? 'Flat' : decision.marketTrend.direction === 'rising' ? 'Rising' : 'Falling'}
          sub={decision.marketTrend.pctPer30d != null ? `${signedPercent(decision.marketTrend.pctPer30d)} / 30d · ${decision.marketTrend.basis}` : `${decision.marketTrend.points} points`}
          tone={decision.marketTrend.basis !== 'history' ? 'neutral' : decision.marketTrend.direction === 'rising' ? 'good' : decision.marketTrend.direction === 'falling' ? 'bad' : 'neutral'}
          hint="Only history with at least 3 distinct capture dates spanning at least 14 days can drive a recommendation."
        />
      </div>

      <div className="mb-6">
        <Panel title="Sold-market aggregates by lookback window" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 760 }}>
              <thead>
                <tr className="border-line border-b">
                  {['Window', 'Price', 'Buyer ship', 'Buyer total', 'Sold qty', 'Velocity', 'Basis / source'].map((header, i) => (
                    <th key={header} scope="col" className={`text-ink-faint pb-2 text-xs font-medium tracking-widest uppercase ${i === 0 || i === 6 ? 'text-left' : 'px-3 text-right'}`}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODS.map((period) => {
                  const observation = part.periods[period]
                  const total = observation?.price == null ? null : observation.price + (observation.shipping ?? 0)
                  return (
                    <tr key={period} className="border-line/50 border-b last:border-0">
                      <td className="text-ink-dim py-2 font-mono text-xs tracking-widest uppercase">{PERIOD_LABELS[period]}</td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs">{money(observation?.price)}</td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs">{money(observation?.shipping)}</td>
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs font-semibold">{money(total)}</td>
                      <td className="text-ink-dim px-3 py-2 text-right font-mono text-xs">{observation?.soldQty ?? '—'}</td>
                      <td className="text-ink-dim px-3 py-2 text-right font-mono text-xs">{observation?.soldQty == null ? '—' : `${(observation.soldQty / PERIOD_DAYS[period]).toFixed(2)}/day`}</td>
                      <td className="py-2 pl-3">
                        {observation ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Chip tone={observation.priceBasis === 'sold' ? 'good' : observation.priceBasis === 'asking' ? 'warn' : 'dim'}>{PRICE_BASIS_LABELS[observation.priceBasis]}</Chip>
                            <SourceBadge source={observation.source} />
                            <span className="text-ink-faint font-mono text-[10px]">{relativeTime(observation.capturedAt)}{observation.sampleSize ? ` · n=${observation.sampleSize}` : ''}</span>
                          </span>
                        ) : <span className="text-ink-ghost font-mono text-xs">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-ink-faint mt-3 text-xs">Nested sold windows are aggregates, not a time series. Sold quantity is normalized to units/day when windows are compared.</p>
        </Panel>
      </div>

      <div className="mb-6">
        <Panel title="Active eBay competition — point in time">
          {active ? (
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="Median asking" value={money(active.askingPrice)} sub={active.source === 'ebay_browse' ? 'used active listings' : 'manual'} />
              <StatCard label="Buyer shipping" value={money(active.askingShipping)} />
              <StatCard label="Active listings" value={active.activeQty == null ? '—' : String(active.activeQty)} sub={active.truncated ? 'truncated sample; count withheld' : 'point-in-time competition'} tone={active.truncated ? 'warn' : 'neutral'} />
              <StatCard label="Qualified sample" value={active.sampleSize == null ? '—' : String(active.sampleSize)} sub={active.mpnRejectedCount != null ? `${active.mpnRejectedCount} wrong-MPN rejected` : relativeTime(active.capturedAt)} />
            </div>
          ) : (
            <p className="text-ink-dim text-sm">No active-listing snapshot yet. Preview eBay Active in the Tracker or enter the point-in-time values manually.</p>
          )}
        </Panel>
      </div>

      {hasWindowData ? (
        <div className="mb-6 grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Panel title="Current lookback curve — context only"><WindowCurveChart data={chartData} /></Panel>
          <Panel title="Price vs buyer shipping"><PriceShippingChart data={chartData} /></Panel>
          <Panel title="Sold velocity"><SoldVelocityChart data={chartData} /></Panel>
        </div>
      ) : (
        <div className="mb-6"><Notice tone="info">No sold-window data yet. Enter sold comps in the Tracker or run an authorized Marketplace Insights sync.</Notice></div>
      )}

      <div className="mb-6 grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <Panel title={`${PERIOD_LABELS[historyPeriod]} sold price over calendar time`}>
          {soldHistory.length >= 2 ? <SoldHistoryChart data={soldHistory} label={`${PERIOD_LABELS[historyPeriod]} sold buyer total`} /> : <p className="text-ink-dim py-6 text-center text-sm">Historical sold-price trend needs repeated captures. Same-day corrections are kept in the database but collapsed to the latest reading for trend math.</p>}
        </Panel>
        <Panel title="Active competition over calendar time">
          {supplyHistory.length >= 2 ? <ActiveSupplyHistoryChart data={supplyHistory} /> : <p className="text-ink-dim py-6 text-center text-sm">Active supply is a point-in-time measure. Its trend appears after repeated captures; at least 3 distinct dates spanning 14 days are required before it can affect a recommendation.</p>}
        </Panel>
      </div>

      <p className="text-ink-faint mb-6 text-xs">Enter or correct market observations in the <Link href="/tracker" className="text-info hover:text-good transition-colors">Tracker</Link>. Nothing is written while you type; only an explicit Save MPN persists changes.</p>

      <PartDetailForm partId={part.id} description={part.description} category={part.category} notes={part.notes} sourceUrl={part.sourceUrl} active={part.active} />
    </div>
  )
}
