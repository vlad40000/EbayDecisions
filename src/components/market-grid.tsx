'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { saveMarketPart, type ActiveInput, type WindowInput } from '@/app/(app)/tracker/actions'
import { money, relativeTime } from '@/lib/format'
import {
  PERIODS,
  PERIOD_LABELS,
  PRICE_BASIS_LABELS,
  type ActiveMarketObservation,
  type Period,
  type PriceBasis,
  type SnapshotSource,
} from '@/lib/types'

import { Chip, EmptyState, SourceBadge } from './ui'

export type GridPeriod = {
  price: number | null
  shipping: number | null
  soldQty: number | null
  source: SnapshotSource
  priceBasis: PriceBasis
  sampleSize: number | null
  capturedAt: string
}

export type GridRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  periods: Partial<Record<Period, GridPeriod>>
  activeMarket: ActiveMarketObservation | null
}

type PartState = 'idle' | 'saving' | 'saved' | 'error'
type Drafts = Record<number, Record<string, string>>

type Preview = {
  askingPrice: number | null
  askingShipping: number | null
  activeQty: number | null
  sampleSize: number
  broadMatchCount: number | null
  mpnRejectedCount: number
  conditionRejectedCount: number
  truncated: boolean
}

const periodKey = (period: Period, field: 'price' | 'shipping' | 'soldQty' | 'priceBasis') =>
  `period:${period}:${field}`
const activeKey = (field: 'askingPrice' | 'askingShipping' | 'activeQty') => `active:${field}`

function inputNumber(value: number | null | undefined, integer = false): string {
  if (value == null) return ''
  return integer ? String(Math.round(value)) : value.toFixed(2)
}

export function MarketGrid({ rows }: { rows: GridRow[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [states, setStates] = useState<Record<number, PartState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [previews, setPreviews] = useState<Record<number, Preview>>({})
  const [previewing, setPreviewing] = useState<Record<number, boolean>>({})
  const [activeOrigins, setActiveOrigins] = useState<Record<number, 'manual' | 'ebay_browse'>>({})
  const draftsRef = useRef(drafts)

  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  const pendingCount = useMemo(
    () => Object.values(drafts).filter((draft) => Object.keys(draft).length > 0).length,
    [drafts],
  )

  useEffect(() => {
    if (pendingCount === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pendingCount])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(
      (row) =>
        row.mpn.toLowerCase().includes(query) || row.description.toLowerCase().includes(query),
    )
  }, [rows, search])

  const setDraft = useCallback((partId: number, key: string, value: string) => {
    setDrafts((previous) => ({
      ...previous,
      [partId]: { ...(previous[partId] ?? {}), [key]: value },
    }))
    setStates((previous) => ({ ...previous, [partId]: 'idle' }))
  }, [])

  const displayedPeriod = (row: GridRow, period: Period, field: 'price' | 'shipping' | 'soldQty') => {
    const draft = drafts[row.partId]?.[periodKey(period, field)]
    if (draft !== undefined) return draft
    const value = row.periods[period]?.[field]
    return inputNumber(value, field === 'soldQty')
  }

  const displayedBasis = (row: GridRow, period: Period): PriceBasis => {
    const draft = drafts[row.partId]?.[periodKey(period, 'priceBasis')]
    return (draft as PriceBasis | undefined) ?? row.periods[period]?.priceBasis ?? 'unknown'
  }

  const displayedActive = (row: GridRow, field: 'askingPrice' | 'askingShipping' | 'activeQty') => {
    const draft = drafts[row.partId]?.[activeKey(field)]
    if (draft !== undefined) return draft
    const value = row.activeMarket?.[field]
    return inputNumber(value, field === 'activeQty')
  }

  const commit = useCallback(async (row: GridRow) => {
    const draft = draftsRef.current[row.partId]
    if (!draft || Object.keys(draft).length === 0) return

    const windows = new Map<Period, WindowInput>()
    const active: ActiveInput = {}
    let hasActive = false

    for (const [key, value] of Object.entries(draft)) {
      const pieces = key.split(':')
      if (pieces[0] === 'period') {
        const period = pieces[1] as Period
        const field = pieces[2] as 'price' | 'shipping' | 'soldQty' | 'priceBasis'
        const window = windows.get(period) ?? { period }
        window[field] = value
        windows.set(period, window)
      } else if (pieces[0] === 'active') {
        const field = pieces[1] as 'askingPrice' | 'askingShipping' | 'activeQty'
        active[field] = value
        hasActive = true
      }
    }

    if (hasActive) {
      const origin = activeOrigins[row.partId] ?? 'manual'
      active.source = origin
      if (origin === 'ebay_browse') {
        const preview = previews[row.partId]
        if (preview) {
          active.sampleSize = preview.sampleSize
          active.broadMatchCount = preview.broadMatchCount
          active.mpnRejectedCount = preview.mpnRejectedCount
          active.conditionRejectedCount = preview.conditionRejectedCount
          active.truncated = preview.truncated
        }
      }
    }

    const sent = { ...draft }
    setStates((previous) => ({ ...previous, [row.partId]: 'saving' }))
    const result = await saveMarketPart({
      partId: row.partId,
      windows: [...windows.values()],
      ...(hasActive ? { active } : {}),
    })

    if (!result.ok) {
      setStates((previous) => ({ ...previous, [row.partId]: 'error' }))
      setErrors((previous) => ({ ...previous, [row.partId]: result.error }))
      return
    }

    setDrafts((previous) => {
      const remaining = { ...(previous[row.partId] ?? {}) }
      for (const [key, value] of Object.entries(sent)) {
        if (remaining[key] === value) delete remaining[key]
      }
      return { ...previous, [row.partId]: remaining }
    })
    setErrors((previous) => {
      const next = { ...previous }
      delete next[row.partId]
      return next
    })
    setStates((previous) => ({ ...previous, [row.partId]: 'saved' }))
    router.refresh()
    setTimeout(() => {
      setStates((previous) =>
        previous[row.partId] === 'saved' ? { ...previous, [row.partId]: 'idle' } : previous,
      )
    }, 1800)
  }, [activeOrigins, previews, router])

  const previewActive = useCallback(async (row: GridRow) => {
    setPreviewing((previous) => ({ ...previous, [row.partId]: true }))
    setErrors((previous) => {
      const next = { ...previous }
      delete next[row.partId]
      return next
    })
    try {
      const response = await fetch(`/api/ebay/preview/${encodeURIComponent(row.mpn)}`, {
        cache: 'no-store',
      })
      const body = (await response.json()) as Preview & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not preview eBay.')
      setPreviews((previous) => ({ ...previous, [row.partId]: body }))
      if (body.askingPrice != null) setDraft(row.partId, activeKey('askingPrice'), body.askingPrice.toFixed(2))
      if (body.askingShipping != null) setDraft(row.partId, activeKey('askingShipping'), body.askingShipping.toFixed(2))
      if (body.activeQty != null) setDraft(row.partId, activeKey('activeQty'), String(body.activeQty))
      setActiveOrigins((previous) => ({ ...previous, [row.partId]: 'ebay_browse' }))
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [row.partId]: error instanceof Error ? error.message : 'Could not preview eBay.',
      }))
    } finally {
      setPreviewing((previous) => ({ ...previous, [row.partId]: false }))
    }
  }, [setDraft])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No parts to track"
        body="Seed the catalogue with pnpm db:seed, or add parts from Inventory."
        cta={{ href: '/inventory', label: 'Go to Inventory' }}
      />
    )
  }

  const columns = `minmax(140px, 180px) minmax(0, 1fr) 52px repeat(5, minmax(86px, 104px))`

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by MPN or description…"
          aria-label="Filter parts"
          className="field max-w-sm flex-1 px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-good)]"
        />
        <span className="text-ink-faint text-xs">
          {visible.length} parts · no autosave · Neon writes only when you press Save MPN
        </span>
        {pendingCount > 0 && (
          <span className="text-warn font-mono text-xs" role="status">
            ● {pendingCount} MPN{pendingCount === 1 ? '' : 's'} with unsaved edits
          </span>
        )}
      </div>

      <div className="border-line overflow-x-auto rounded border">
        <div style={{ minWidth: 900 }}>
          <div
            className="bg-surface border-line text-ink-faint grid border-b px-4 py-2.5 text-xs font-medium tracking-widest uppercase"
            style={{ gridTemplateColumns: columns }}
          >
            <div>MPN</div>
            <div>Description</div>
            <div className="text-center">Qty</div>
            {PERIODS.map((period) => (
              <div key={period} className="text-center">{PERIOD_LABELS[period]}</div>
            ))}
          </div>

          {visible.map((row, index) => {
            const isOpen = open === row.partId
            const draft = drafts[row.partId] ?? {}
            const unsaved = Object.keys(draft).length > 0
            const state = states[row.partId] ?? 'idle'
            const preview = previews[row.partId]

            return (
              <div key={row.partId} className={index < visible.length - 1 ? 'border-line border-b' : ''}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : row.partId)}
                  aria-expanded={isOpen}
                  className={`grid w-full items-center px-4 py-3 text-left transition-colors ${
                    isOpen ? 'bg-good/[0.05]' : index % 2 === 1 ? 'bg-white/[0.015]' : ''
                  } hover:bg-good/[0.04]`}
                  style={{ gridTemplateColumns: columns }}
                >
                  <span className="text-info flex items-center gap-1.5 font-mono text-xs">
                    {row.mpn}
                    {unsaved && <span className="text-warn" title="Unsaved edits">●</span>}
                    {state === 'saved' && <span className="text-good" title="Saved">✓</span>}
                    {state === 'error' && <span className="text-bad" title="Save failed">!</span>}
                  </span>
                  <span className="text-ink truncate pr-4 text-sm">{row.description}</span>
                  <span className="text-ink-dim text-center font-mono text-xs">{row.inventoryQty}</span>
                  {PERIODS.map((period) => {
                    const priceRaw = displayedPeriod(row, period, 'price')
                    const shippingRaw = displayedPeriod(row, period, 'shipping')
                    const price = priceRaw === '' ? null : Number(priceRaw)
                    const shipping = shippingRaw === '' ? 0 : Number(shippingRaw)
                    const total = price != null && Number.isFinite(price) ? price + (Number.isFinite(shipping) ? shipping : 0) : null
                    return (
                      <span key={period} className="text-ink-dim text-center font-mono text-xs">
                        {money(total)}
                      </span>
                    )
                  })}
                </button>

                {isOpen && (
                  <div className="border-line bg-surface/40 border-t px-4 py-4">
                    <div className="grid gap-3 xl:grid-cols-5">
                      {PERIODS.map((period) => {
                        const observation = row.periods[period]
                        return (
                          <section key={period} className="border-line rounded border p-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <h3 className="text-ink-dim font-mono text-xs tracking-widest uppercase">{PERIOD_LABELS[period]}</h3>
                              {observation && <SourceBadge source={observation.source} />}
                            </div>
                            <label className="text-ink-faint block text-[10px] tracking-widest uppercase">Price</label>
                            <input
                              inputMode="decimal"
                              value={displayedPeriod(row, period, 'price')}
                              onChange={(event) => setDraft(row.partId, periodKey(period, 'price'), event.target.value)}
                              className="field mb-2 w-full px-2 py-1.5 font-mono text-xs"
                            />
                            <label className="text-ink-faint block text-[10px] tracking-widest uppercase">Buyer shipping</label>
                            <input
                              inputMode="decimal"
                              value={displayedPeriod(row, period, 'shipping')}
                              onChange={(event) => setDraft(row.partId, periodKey(period, 'shipping'), event.target.value)}
                              className="field mb-2 w-full px-2 py-1.5 font-mono text-xs"
                            />
                            <label className="text-ink-faint block text-[10px] tracking-widest uppercase">Sold qty</label>
                            <input
                              inputMode="numeric"
                              value={displayedPeriod(row, period, 'soldQty')}
                              onChange={(event) => setDraft(row.partId, periodKey(period, 'soldQty'), event.target.value)}
                              className="field mb-2 w-full px-2 py-1.5 font-mono text-xs"
                            />
                            <label className="text-ink-faint block text-[10px] tracking-widest uppercase">Price basis</label>
                            <select
                              value={displayedBasis(row, period)}
                              onChange={(event) => setDraft(row.partId, periodKey(period, 'priceBasis'), event.target.value)}
                              className="field w-full px-2 py-1.5 font-mono text-xs"
                            >
                              {(Object.keys(PRICE_BASIS_LABELS) as PriceBasis[]).map((basis) => (
                                <option key={basis} value={basis}>{PRICE_BASIS_LABELS[basis]}</option>
                              ))}
                            </select>
                            {observation && (
                              <p className="text-ink-ghost mt-2 font-mono text-[10px]">
                                {relativeTime(observation.capturedAt)}
                                {observation.sampleSize != null ? ` · n=${observation.sampleSize}` : ''}
                              </p>
                            )}
                          </section>
                        )
                      })}
                    </div>

                    <section className="border-line mt-4 rounded border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-ink text-sm font-medium">Active eBay competition — point in time</h3>
                          <p className="text-ink-faint mt-0.5 text-xs">Separate from sold lookback windows. Repeated captures build the supply trend.</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void previewActive(row)}
                          disabled={previewing[row.partId]}
                          className="border-line bg-surface text-info hover:border-info/40 rounded border px-3 py-1.5 font-mono text-xs disabled:opacity-50"
                        >
                          {previewing[row.partId] ? 'Checking eBay…' : 'Preview eBay Active'}
                        </button>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        {([
                          ['askingPrice', 'Median asking price'],
                          ['askingShipping', 'Median buyer shipping'],
                          ['activeQty', 'Active listing qty'],
                        ] as const).map(([field, label]) => (
                          <label key={field} className="text-ink-faint text-[10px] tracking-widest uppercase">
                            {label}
                            <input
                              inputMode={field === 'activeQty' ? 'numeric' : 'decimal'}
                              value={displayedActive(row, field)}
                              onChange={(event) => {
                                setDraft(row.partId, activeKey(field), event.target.value)
                                setActiveOrigins((previous) => ({ ...previous, [row.partId]: 'manual' }))
                              }}
                              className="field mt-1 w-full px-2 py-1.5 font-mono text-xs normal-case tracking-normal"
                            />
                          </label>
                        ))}
                      </div>

                      {row.activeMarket && (
                        <p className="text-ink-ghost mt-2 font-mono text-[10px]">
                          Stored {relativeTime(row.activeMarket.capturedAt)} · {row.activeMarket.source === 'ebay_browse' ? 'eBay Browse' : 'manual'}
                          {row.activeMarket.truncated ? ' · count withheld because results were truncated' : ''}
                        </p>
                      )}
                      {preview && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Chip tone="info">Preview sample n={preview.sampleSize}</Chip>
                          <Chip tone="dim">Rejected wrong MPN: {preview.mpnRejectedCount}</Chip>
                          <Chip tone="dim">Rejected condition: {preview.conditionRejectedCount}</Chip>
                          {preview.truncated && <Chip tone="warn">Broad result truncated — Active Qty not applied</Chip>}
                        </div>
                      )}
                    </section>

                    {errors[row.partId] && (
                      <p className="text-bad mt-3 text-xs" role="alert">{errors[row.partId]}</p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-ink-faint text-xs">
                        {unsaved ? 'Edits are local until saved.' : 'No unsaved edits.'}{' '}
                        <Link href={`/inventory/${encodeURIComponent(row.mpn)}`} className="text-info hover:text-good">Open detail →</Link>
                      </div>
                      <button
                        type="button"
                        onClick={() => void commit(row)}
                        disabled={!unsaved || state === 'saving'}
                        className="bg-good text-black rounded px-4 py-2 font-mono text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {state === 'saving' ? 'Saving…' : 'Save MPN'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {visible.length === 0 && (
        <p className="text-ink-faint py-6 text-center text-sm">Nothing matches that filter.</p>
      )}
    </div>
  )
}
