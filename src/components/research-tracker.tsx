'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import {
  saveResearch,
  type ResearchSaveSource,
  type ResearchWindowFormInput,
} from '@/app/(app)/tracker/actions'
import { Chip, EmptyState } from '@/components/ui'
import { PERIODS, PERIOD_LABELS, type Period, type PeriodObservation } from '@/lib/types'

export type ResearchTrackerRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  lastResearchedAt: string | null
  periods: Partial<Record<Period, PeriodObservation>>
}

type Field =
  | 'avgSoldPrice'
  | 'avgShipping'
  | 'totalSold'
  | 'soldPriceMin'
  | 'soldPriceMax'
  | 'totalSellers'
  | 'sellThroughPct'
  | 'freeShippingPct'

type Drafts = Record<number, Partial<Record<Period, Partial<Record<Field, string>>>>>

type AssistedWindow = {
  avgSoldPrice: number | null
  avgShipping: number | null
  totalSold: number | null
  soldPriceMin: number | null
  soldPriceMax: number | null
  freeShippingPct: number | null
  sampleSize: number
}

type EbaySoldPreview = {
  source: 'ebay_marketplace_insights'
  windows: Partial<Record<'90d' | '30d' | '7d', AssistedWindow>>
  exactMpnVerified: boolean
  mpnRejectedCount: number
  truncated: boolean
}

const ASSISTED_PERIODS = ['7d', '30d', '90d'] as const

function initialValue(observation: PeriodObservation | undefined, field: Field): string {
  const value = {
    avgSoldPrice: observation?.price,
    avgShipping: observation?.shipping,
    totalSold: observation?.soldQty,
    soldPriceMin: observation?.soldPriceMin,
    soldPriceMax: observation?.soldPriceMax,
    totalSellers: observation?.totalSellers,
    sellThroughPct: observation?.sellThroughPct,
    freeShippingPct: observation?.freeShippingPct,
  }[field]

  if (value == null) return ''
  if (field === 'totalSold' || field === 'totalSellers') return String(Math.round(value))
  return String(value)
}

function lastResearchedLabel(iso: string | null): string {
  if (!iso) return 'Not researched'
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

function decimalDraft(value: number | null): string {
  return value == null ? '' : value.toFixed(2)
}

function integerDraft(value: number | null): string {
  return value == null ? '' : String(Math.round(value))
}

export function ResearchTracker({ rows }: { rows: ResearchTrackerRow[] }) {
  const router = useRouter()
  const [open, setOpen] = useState<number | null>(rows.length === 1 ? rows[0]!.partId : null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [saving, setSaving] = useState<number | null>(null)
  const [fetching, setFetching] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [previews, setPreviews] = useState<Record<number, EbaySoldPreview>>({})

  const dirtyCount = useMemo(
    () =>
      Object.values(drafts).filter((partDraft) =>
        Object.values(partDraft).some((periodDraft) => Object.keys(periodDraft ?? {}).length > 0),
      ).length,
    [drafts],
  )

  useEffect(() => {
    if (dirtyCount === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirtyCount])

  function value(row: ResearchTrackerRow, period: Period, field: Field): string {
    const drafted = drafts[row.partId]?.[period]?.[field]
    return drafted ?? initialValue(row.periods[period], field)
  }

  function setValue(row: ResearchTrackerRow, period: Period, field: Field, next: string) {
    setDrafts((current) => ({
      ...current,
      [row.partId]: {
        ...(current[row.partId] ?? {}),
        [period]: {
          ...(current[row.partId]?.[period] ?? {}),
          [field]: next,
        },
      },
    }))
    setSaved((current) => (current === row.partId ? null : current))
  }

  async function fetchEbaySold(row: ResearchTrackerRow) {
    setFetching(row.partId)
    setErrors((current) => {
      const next = { ...current }
      delete next[row.partId]
      return next
    })

    try {
      const response = await fetch(`/api/ebay/research/${encodeURIComponent(row.mpn)}`, {
        cache: 'no-store',
      })
      const body = (await response.json()) as EbaySoldPreview | { error?: string }

      if (!response.ok || !('windows' in body)) {
        throw new Error('error' in body && body.error ? body.error : 'Could not fetch eBay SOLD research.')
      }

      setDrafts((current) => {
        const partDraft = { ...(current[row.partId] ?? {}) }

        for (const period of ASSISTED_PERIODS) {
          const window = body.windows[period]
          if (!window) continue

          partDraft[period] = {
            ...(partDraft[period] ?? {}),
            avgSoldPrice: decimalDraft(window.avgSoldPrice),
            avgShipping: decimalDraft(window.avgShipping),
            totalSold: integerDraft(window.totalSold),
            soldPriceMin: decimalDraft(window.soldPriceMin),
            soldPriceMax: decimalDraft(window.soldPriceMax),
            freeShippingPct: decimalDraft(window.freeShippingPct),
          }
        }

        return { ...current, [row.partId]: partDraft }
      })

      setPreviews((current) => ({ ...current, [row.partId]: body }))
      setSaved((current) => (current === row.partId ? null : current))
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [row.partId]: error instanceof Error ? error.message : 'Could not fetch eBay SOLD research.',
      }))
    } finally {
      setFetching(null)
    }
  }

  async function commit(row: ResearchTrackerRow) {
    const windows: ResearchWindowFormInput[] = PERIODS.map((period) => ({
      period,
      avgSoldPrice: value(row, period, 'avgSoldPrice'),
      avgShipping: value(row, period, 'avgShipping'),
      totalSold: value(row, period, 'totalSold'),
      soldPriceMin: value(row, period, 'soldPriceMin'),
      soldPriceMax: value(row, period, 'soldPriceMax'),
      totalSellers: value(row, period, 'totalSellers'),
      sellThroughPct: value(row, period, 'sellThroughPct'),
      freeShippingPct: value(row, period, 'freeShippingPct'),
    }))

    const source: ResearchSaveSource = previews[row.partId]
      ? 'ebay_insights_reviewed'
      : 'ebay_product_research_manual'

    setSaving(row.partId)
    setErrors((current) => {
      const next = { ...current }
      delete next[row.partId]
      return next
    })

    const result = await saveResearch({ partId: row.partId, source, windows })
    setSaving(null)

    if (!result.ok) {
      setErrors((current) => ({ ...current, [row.partId]: result.error }))
      return
    }

    setDrafts((current) => {
      const next = { ...current }
      delete next[row.partId]
      return next
    })
    setPreviews((current) => {
      const next = { ...current }
      delete next[row.partId]
      return next
    })
    setSaved(row.partId)
    router.refresh()
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No MPNs match this Tracker view"
        body="Use Market Opportunities or Research Queue to choose a working set, or change the Tracker search."
        cta={{ href: '/research', label: 'Open Research Queue' }}
      />
    )
  }

  return (
    <div>
      {dirtyCount > 0 && (
        <div className="text-warn mb-3 font-mono text-xs" role="status">
          ● {dirtyCount} MPN{dirtyCount === 1 ? '' : 's'} with unsaved research edits
        </div>
      )}

      <div className="border-line overflow-hidden rounded border">
        <div className="overflow-x-auto">
          <div style={{ minWidth: 880 }}>
            <div
              className="bg-surface-2 border-line text-ink-faint grid border-b px-4 py-2.5 text-xs font-medium tracking-widest uppercase"
              style={{ gridTemplateColumns: '170px 60px minmax(260px,1fr) repeat(5,72px) 120px' }}
            >
              <div>MPN</div>
              <div className="text-right">Qty</div>
              <div>Description</div>
              {PERIODS.map((period) => (
                <div key={period} className="text-right">
                  {PERIOD_LABELS[period]
                    .replace(' Months', 'm')
                    .replace(' Days', 'd')
                    .replace(' Year', 'y')}
                </div>
              ))}
              <div className="text-right">Updated</div>
            </div>

            {rows.map((row) => {
              const isOpen = open === row.partId
              const preview = previews[row.partId]

              return (
                <div key={row.partId} className="border-line border-b last:border-0">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : row.partId)}
                    aria-expanded={isOpen}
                    className="hover:bg-good/[0.04] grid w-full items-center px-4 py-3 text-left transition-colors"
                    style={{ gridTemplateColumns: '170px 60px minmax(260px,1fr) repeat(5,72px) 120px' }}
                  >
                    <span className="text-info font-mono text-xs font-semibold">
                      {row.mpn}
                      {drafts[row.partId] && <span className="text-warn ml-1">●</span>}
                      {saved === row.partId && <span className="text-good ml-1">✓</span>}
                    </span>
                    <span className="text-ink text-right font-mono text-xs">{row.inventoryQty}</span>
                    <span className="text-ink-dim truncate pr-4 text-xs">{row.description}</span>
                    {PERIODS.map((period) => (
                      <span key={period} className="text-ink text-right font-mono text-xs">
                        {row.periods[period]?.soldQty ?? '—'}
                      </span>
                    ))}
                    <span className="text-ink-faint text-right font-mono text-[10px]">
                      {lastResearchedLabel(row.lastResearchedAt)}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="bg-surface/50 border-line border-t p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-ink text-sm font-medium">
                            eBay Product Research — {row.mpn}
                          </h3>
                          <p className="text-ink-faint mt-0.5 max-w-2xl text-xs">
                            Enter all five windows manually, or fetch recent eBay SOLD data into the
                            7d/30d/90d draft fields when Marketplace Insights access is available.
                            Fetching never writes to Neon.
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void fetchEbaySold(row)}
                            disabled={fetching === row.partId || saving === row.partId}
                            className="border-info/40 bg-info/10 text-info hover:bg-info/20 rounded border px-3 py-1.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {fetching === row.partId ? 'Fetching SOLD…' : 'Fetch eBay SOLD'}
                          </button>
                          <Chip tone={row.lastResearchedAt ? 'info' : 'dim'}>
                            {lastResearchedLabel(row.lastResearchedAt)}
                          </Chip>
                        </div>
                      </div>

                      {preview && (
                        <div className="border-line bg-surface mb-3 rounded border px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Chip tone="info">Insights preview</Chip>
                            <Chip tone={preview.exactMpnVerified ? 'good' : 'warn'}>
                              {preview.exactMpnVerified ? 'MPN titles verified' : 'MPN qualification unverified'}
                            </Chip>
                            {preview.mpnRejectedCount > 0 && (
                              <Chip tone="dim">{preview.mpnRejectedCount} wrong-MPN rejected</Chip>
                            )}
                            {preview.truncated && <Chip tone="warn">Result truncated · sold counts withheld</Chip>}
                          </div>
                          <p className="text-ink-faint mt-2 text-xs">
                            7d, 30d and 90d draft fields were refreshed from eBay. Review them, then
                            update 6m and 1yr manually before SAVE RESEARCH.
                          </p>
                        </div>
                      )}

                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-xs" style={{ minWidth: 1000 }}>
                          <thead>
                            <tr className="border-line border-b">
                              {[
                                'Period',
                                'Avg Sold',
                                'Avg Shipping',
                                'Total Sold',
                                'Range Low',
                                'Range High',
                                'Sellers',
                                'Sell-through',
                                'Free Ship',
                              ].map((header, index) => (
                                <th
                                  key={header}
                                  className={`text-ink-faint px-1.5 pb-2 text-[10px] font-medium tracking-widest uppercase ${
                                    index === 0 ? 'text-left' : 'text-right'
                                  }`}
                                >
                                  {header}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {PERIODS.map((period) => {
                              const fields: { key: Field; integer?: boolean; suffix?: string }[] = [
                                { key: 'avgSoldPrice' },
                                { key: 'avgShipping' },
                                { key: 'totalSold', integer: true },
                                { key: 'soldPriceMin' },
                                { key: 'soldPriceMax' },
                                { key: 'totalSellers', integer: true },
                                { key: 'sellThroughPct', suffix: '%' },
                                { key: 'freeShippingPct', suffix: '%' },
                              ]

                              return (
                                <tr key={period} className="border-line/50 border-b last:border-0">
                                  <td className="text-ink-dim px-1.5 py-2 font-mono text-xs font-semibold">
                                    {PERIOD_LABELS[period]}
                                  </td>
                                  {fields.map(({ key, integer, suffix }) => (
                                    <td key={key} className="px-1.5 py-1.5">
                                      <div className="relative">
                                        <input
                                          inputMode={integer ? 'numeric' : 'decimal'}
                                          value={value(row, period, key)}
                                          onChange={(event) => setValue(row, period, key, event.target.value)}
                                          aria-label={`${PERIOD_LABELS[period]} ${key}`}
                                          className="field w-full px-2 py-1.5 text-right font-mono text-xs"
                                        />
                                        {suffix && (
                                          <span className="text-ink-ghost pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px]">
                                            {suffix}
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                  ))}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {errors[row.partId] && (
                        <p className="text-bad mt-3 text-xs" role="alert">
                          {errors[row.partId]}
                        </p>
                      )}

                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="text-ink-faint text-xs">
                          One SAVE RESEARCH creates one dated session with all five windows.{' '}
                          <Link
                            href={`/inventory/${encodeURIComponent(row.mpn)}`}
                            className="text-info hover:text-good"
                          >
                            Open history →
                          </Link>
                        </div>
                        <button
                          type="button"
                          onClick={() => void commit(row)}
                          disabled={saving === row.partId || fetching === row.partId}
                          className="bg-good rounded px-4 py-2 font-mono text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {saving === row.partId ? 'Saving research…' : 'SAVE RESEARCH'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
