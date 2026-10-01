'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import { saveResearch, type ResearchWindowFormInput } from '@/app/(app)/tracker/actions'
import { EmptyState } from '@/components/ui'
import { type Period, type PeriodObservation } from '@/lib/types'

export type QuickTrackerRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  lastResearchedAt: string | null
  periods: Partial<Record<Period, PeriodObservation>>
}

const DISPLAY_PERIODS: Period[] = ['7d', '30d', '90d', '6m', '1yr']

type QuickField = Period | 'sellPrice' | 'shipping'
type QuickDrafts = Record<number, Partial<Record<QuickField, string>>>

function numeric(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

function initialValue(row: QuickTrackerRow, field: QuickField): string {
  if (field === 'sellPrice') return numeric(row.periods['30d']?.price)
  if (field === 'shipping') return numeric(row.periods['30d']?.shipping)
  return row.periods[field]?.soldQty == null ? '' : String(row.periods[field]!.soldQty)
}

function preservedWindow(
  row: QuickTrackerRow,
  period: Period,
  drafts: QuickDrafts,
): ResearchWindowFormInput {
  const observation = row.periods[period]
  const partDraft = drafts[row.partId] ?? {}

  return {
    period,
    avgSoldPrice:
      period === '30d'
        ? partDraft.sellPrice ?? numeric(observation?.price)
        : numeric(observation?.price),
    avgShipping:
      period === '30d'
        ? partDraft.shipping ?? numeric(observation?.shipping)
        : numeric(observation?.shipping),
    totalSold: partDraft[period] ?? (observation?.soldQty == null ? '' : String(observation.soldQty)),
    soldPriceMin: numeric(observation?.soldPriceMin),
    soldPriceMax: numeric(observation?.soldPriceMax),
    totalSellers: observation?.totalSellers == null ? '' : String(observation.totalSellers),
    sellThroughPct: numeric(observation?.sellThroughPct),
    freeShippingPct: numeric(observation?.freeShippingPct),
  }
}

export function QuickMarketGrid({ rows }: { rows: QuickTrackerRow[] }) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<QuickDrafts>({})
  const [saving, setSaving] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<number, string>>({})

  const dirtyRows = useMemo(() => Object.keys(drafts).length, [drafts])

  useEffect(() => {
    if (dirtyRows === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirtyRows])

  function value(row: QuickTrackerRow, field: QuickField): string {
    return drafts[row.partId]?.[field] ?? initialValue(row, field)
  }

  function edit(row: QuickTrackerRow, field: QuickField, next: string) {
    setDrafts((current) => ({
      ...current,
      [row.partId]: {
        ...(current[row.partId] ?? {}),
        [field]: next,
      },
    }))
    setSaved((current) => (current === row.partId ? null : current))
  }

  async function save(row: QuickTrackerRow) {
    setSaving(row.partId)
    setErrors((current) => {
      const next = { ...current }
      delete next[row.partId]
      return next
    })

    const windows = DISPLAY_PERIODS.map((period) => preservedWindow(row, period, drafts))
    const result = await saveResearch({ partId: row.partId, windows })
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
    setSaved(row.partId)
    router.refresh()
  }

  if (rows.length === 0) {
    return <EmptyState title="No MPNs found" body="Change the search or add inventory under More → Inventory." />
  }

  return (
    <div>
      {dirtyRows > 0 && (
        <div className="text-warn mb-2 font-mono text-xs">
          ● {dirtyRows} unsaved row{dirtyRows === 1 ? '' : 's'}
        </div>
      )}

      <div className="border-line overflow-x-auto rounded border">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 1180 }}>
          <thead>
            <tr className="bg-[#0f4f68] text-white">
              <th className="px-3 py-2 text-left text-xs font-semibold">MPN</th>
              <th className="px-3 py-2 text-right text-xs font-semibold">Qty</th>
              <th className="px-3 py-2 text-left text-xs font-semibold">Description</th>
              {['7 days', '30 days', '90 days', '6 months', '1 year'].map((label) => (
                <th key={label} className="px-2 py-2 text-right text-xs font-semibold">{label}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-semibold" title="30-day average sold price">
                Sell Price
              </th>
              <th className="px-2 py-2 text-right text-xs font-semibold" title="30-day average buyer-paid shipping">
                Shipping
              </th>
              <th className="px-2 py-2 text-right text-xs font-semibold">Save</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const dirty = drafts[row.partId] != null
              const rowError = errors[row.partId]
              return (
                <tr
                  key={row.partId}
                  className={`border-line border-b last:border-0 ${
                    index % 2 === 0 ? 'bg-info/[0.07]' : 'bg-surface'
                  }`}
                >
                  <td className="px-3 py-1.5">
                    <Link
                      href={`/inventory/${encodeURIComponent(row.mpn)}`}
                      className="text-info hover:text-good font-mono text-sm font-semibold"
                      title="Open dashboard"
                    >
                      {row.mpn}
                    </Link>
                    {saved === row.partId && <span className="text-good ml-1">✓</span>}
                  </td>
                  <td className="text-ink px-3 py-1.5 text-right font-mono">{row.inventoryQty}</td>
                  <td className="text-ink px-3 py-1.5">{row.description}</td>
                  {DISPLAY_PERIODS.map((period) => (
                    <td key={period} className="px-1.5 py-1">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={value(row, period)}
                        onChange={(event) => edit(row, period, event.target.value)}
                        aria-label={`${row.mpn} ${period} sold quantity`}
                        className="field h-8 w-full min-w-16 px-2 text-right font-mono text-sm"
                      />
                    </td>
                  ))}
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={value(row, 'sellPrice')}
                      onChange={(event) => edit(row, 'sellPrice', event.target.value)}
                      aria-label={`${row.mpn} sell price`}
                      className="field h-8 w-full min-w-20 px-2 text-right font-mono text-sm"
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={value(row, 'shipping')}
                      onChange={(event) => edit(row, 'shipping', event.target.value)}
                      aria-label={`${row.mpn} shipping`}
                      className="field h-8 w-full min-w-20 px-2 text-right font-mono text-sm"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => void save(row)}
                      disabled={!dirty || saving === row.partId}
                      className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-2.5 py-1.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      {saving === row.partId ? 'Saving…' : 'Save'}
                    </button>
                    {rowError && <div className="text-bad mt-1 max-w-48 text-[10px]">{rowError}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
