import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PartDetailForm } from '@/components/part-detail-form'
import {
  HistoryChart,
  PriceShippingChart,
  QuantityChart,
  TotalCostChart,
  type HistoryPoint,
  type PeriodPoint,
} from '@/components/part-charts'
import { ActionBadge, Chip, Notice, Panel, SourceBadge, StatCard } from '@/components/ui'
import { getPartWithMarket, getSettings, snapshotHistory } from '@/db/queries'
import { decide } from '@/lib/decisions'
import { money, percent, relativeTime, signedPercent, toNumber } from '@/lib/format'
import { requireSession } from '@/lib/session'
import { trendValueAt } from '@/lib/stats'
import { PERIODS, PERIOD_LABELS } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: { params: Promise<{ mpn: string }> }) {
  const { mpn } = await props.params
  return { title: `${decodeURIComponent(mpn)} — EbayDecisions` }
}

/** Groups raw snapshot rows into one point per capture day per window. */
function buildHistory(
  rows: Awaited<ReturnType<typeof snapshotHistory>>,
): { points: HistoryPoint[]; periods: string[] } {
  const byDay = new Map<string, HistoryPoint>()
  const periodsSeen = new Set<string>()

  for (const row of [...rows].reverse()) {
    const price = toNumber(row.price)
    if (price == null) continue

    const day = row.capturedAt.toISOString().slice(0, 10)
    const total = price + (toNumber(row.shipping) ?? 0)

    const point = byDay.get(day) ?? { at: day }
    point[row.period] = total
    byDay.set(day, point)
    periodsSeen.add(row.period)
  }

  const ordered = PERIODS.filter((period) => periodsSeen.has(period))
  return { points: [...byDay.values()], periods: ordered }
}

export default async function PartDetailPage(props: { params: Promise<{ mpn: string }> }) {
  await requireSession()

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw)

  const [settings, part] = await Promise.all([getSettings(), getPartWithMarket(mpn)])
  if (!part) notFound()

  const decision = decide(part, settings)
  const history = buildHistory(await snapshotHistory(part.id))

  const costSeries = PERIODS.map((period) => {
    const observation = part.periods[period]
    return observation?.price == null ? null : observation.price + (observation.shipping ?? 0)
  })

  const chartData: PeriodPoint[] = PERIODS.map((period, index) => {
    const observation = part.periods[period]
    return {
      period: PERIOD_LABELS[period],
      totalCost: costSeries[index] ?? null,
      trend: trendValueAt(costSeries, decision.costTrend, index),
      price: observation?.price ?? null,
      shipping: observation?.shipping ?? null,
      qty: observation?.qty ?? null,
    }
  })

  const hasAnyMarketData = costSeries.some((value) => value != null)
  const economics = decision.economics

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/inventory"
          className="text-ink-faint hover:text-ink mb-3 inline-block font-mono text-xs transition-colors"
        >
          ← Inventory
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-info font-mono text-lg font-semibold">{part.mpn}</h1>
            <p className="text-ink mt-0.5 text-sm">{part.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip>{part.category}</Chip>
              <Chip tone={part.inventoryQty > 1 ? 'good' : 'dim'}>
                {part.inventoryQty} on hand
              </Chip>
              {!part.active && <Chip tone="warn">Inactive</Chip>}
              {part.sourceUrl && (
                <a
                  href={part.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-faint hover:text-info font-mono text-xs transition-colors"
                >
                  reference ↗
                </a>
              )}
            </div>
          </div>
          <ActionBadge action={decision.action} />
        </div>
      </div>

      {/* Decision */}
      <div className="mb-6">
        <Panel title="Recommendation">
          <p className="text-ink text-sm">{decision.reason}</p>

          {decision.notes.length > 0 && (
            <ul className="text-ink-dim mt-2 space-y-0.5 text-xs">
              {decision.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          )}

          {(decision.suggestedListPrice != null || decision.askingPricesOnly) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {decision.suggestedListPrice != null && (
                <Chip tone="info">
                  Target {decision.targetMarginPct.toFixed(0)}% margin at{' '}
                  {money(decision.suggestedListPrice)} + {money(economics?.shipping ?? 0)} shipping
                </Chip>
              )}
              {decision.askingPricesOnly && (
                <Chip tone="warn">Asking prices, not sold comps</Chip>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* Economics */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Buyer pays"
          value={money(economics?.grossOrder)}
          sub={
            economics
              ? `${money(economics.price)} + ${money(economics.shipping)} ship`
              : 'No comps yet'
          }
          hint="Item price plus the shipping the comps show. eBay charges its fee on this total."
        />
        <StatCard
          label="You net"
          value={money(economics?.netProceeds)}
          sub={
            economics
              ? `after ${money(economics.fees)} fees, ${money(economics.shipCost)} ship`
              : undefined
          }
          hint={`Fee model: ${settings.feePct}% of the order plus ${money(settings.feeFixed)} fixed.`}
        />
        <StatCard
          label="Margin"
          value={money(economics?.marginDollars)}
          sub={
            economics?.marginPct != null
              ? `${percent(economics.marginPct)}${economics.roiPct != null ? ` · ${percent(economics.roiPct, 0)} ROI` : ''}`
              : part.costBasis == null
                ? 'Set a cost basis'
                : undefined
          }
          tone={
            economics?.marginDollars == null
              ? 'neutral'
              : economics.marginDollars < 0
                ? 'bad'
                : 'good'
          }
        />
        <StatCard
          label="Market trend"
          value={
            decision.costTrend.direction === 'unknown'
              ? '—'
              : decision.costTrend.direction === 'flat'
                ? 'Flat'
                : decision.costTrend.direction === 'rising'
                  ? 'Rising'
                  : 'Falling'
          }
          sub={
            decision.costTrend.pctPerPeriod != null
              ? `${signedPercent(decision.costTrend.pctPerPeriod)} per window`
              : `${decision.costTrend.points} of 5 windows`
          }
          tone={
            decision.costTrend.direction === 'rising'
              ? 'good'
              : decision.costTrend.direction === 'falling'
                ? 'bad'
                : 'neutral'
          }
          hint="Least-squares fit across the windows that have data, normalised by the mean."
        />
      </div>

      {/* Table view — also the accessible alternative to the charts. */}
      <div className="mb-6">
        <Panel title="Observed market by window" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 620 }}>
              <thead>
                <tr className="border-line border-b">
                  {['Window', 'Price', 'Shipping', 'Total', 'Units', 'Source'].map((header, i) => (
                    <th
                      key={header}
                      scope="col"
                      className={`text-ink-faint pb-2 text-xs font-medium tracking-widest uppercase ${
                        i === 0 ? 'text-left' : i === 5 ? 'pl-3 text-left' : 'px-3 text-right'
                      }`}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODS.map((period) => {
                  const observation = part.periods[period]
                  const total =
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
                      <td className="text-ink px-3 py-2 text-right font-mono text-xs">
                        {money(observation?.shipping)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono text-xs font-semibold ${
                          total == null ? 'text-ink-ghost' : 'text-ink'
                        }`}
                      >
                        {money(total)}
                      </td>
                      <td className="text-ink-dim px-3 py-2 text-right font-mono text-xs">
                        {observation?.qty ?? '—'}
                      </td>
                      <td className="py-2 pl-3">
                        {observation ? (
                          <span className="flex items-center gap-1.5">
                            <SourceBadge source={observation.source} />
                            <span className="text-ink-faint font-mono text-[10px]">
                              {relativeTime(observation.capturedAt)}
                              {observation.sampleSize != null && observation.sampleSize > 0
                                ? ` · n=${observation.sampleSize}`
                                : ''}
                            </span>
                          </span>
                        ) : (
                          <span className="text-ink-ghost font-mono text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-ink-faint mt-3 text-xs">
            Enter or correct any of these in the{' '}
            <Link href="/tracker" className="text-info hover:text-good transition-colors">
              Tracker
            </Link>
            .
          </p>
        </Panel>
      </div>

      {/* Charts */}
      {hasAnyMarketData ? (
        <>
          <div
            className="mb-6 grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}
          >
            <Panel title="Total cost across windows">
              <TotalCostChart data={chartData} />
            </Panel>
            <Panel title="Price vs shipping">
              <PriceShippingChart data={chartData} />
            </Panel>
            <Panel title="Units observed">
              <QuantityChart data={chartData} />
            </Panel>
          </div>

          <div className="mb-6">
            <Panel title="Comps over calendar time">
              {history.points.length >= 2 ? (
                <HistoryChart data={history.points} periods={history.periods} />
              ) : (
                <p className="text-ink-dim py-6 text-center text-sm">
                  History builds up as readings accumulate. Every sync and every manual edit is
                  kept, so after a few passes this shows how each window&apos;s comp has actually
                  moved — something a single snapshot cannot tell you.
                </p>
              )}
            </Panel>
          </div>
        </>
      ) : (
        <div className="mb-6">
          <Notice tone="info">
            No market data for this part yet. Run a sync from the Decisions page, or enter comps in
            the Tracker.
          </Notice>
        </div>
      )}

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
