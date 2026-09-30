'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { saveMarketField } from '@/app/(app)/tracker/actions'
import { money, relativeTime } from '@/lib/format'
import { PERIODS, PERIOD_LABELS, type Period, type SnapshotSource } from '@/lib/types'

import { EmptyState, SourceBadge } from './ui'

export type GridPeriod = {
  price: number | null
  shipping: number | null
  qty: number | null
  source: SnapshotSource
  capturedAt: string
}

export type GridRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  periods: Partial<Record<Period, GridPeriod>>
}

type Field = 'price' | 'shipping' | 'qty'
const FIELDS: Field[] = ['price', 'shipping', 'qty']

const DEBOUNCE_MS = 700

type CellState = 'idle' | 'saving' | 'saved' | 'error'

const cellKey = (partId: number, period: Period, field: Field) => `${partId}:${period}:${field}`

function toInputValue(value: number | null | undefined, field: Field): string {
  if (value == null) return ''
  return field === 'qty' ? String(Math.round(value)) : value.toFixed(2)
}

export function MarketGrid({ rows }: { rows: GridRow[] }) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  /**
   * Locally edited values, keyed by cell. The input reads from here when
   * present so a keystroke is never fought by the value coming back from the
   * server mid-typing.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [states, setStates] = useState<Record<string, CellState>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Clear any pending saves if the component goes away mid-edit.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of Object.values(pending)) clearTimeout(timer)
    }
  }, [])

  const commit = useCallback(
    async (partId: number, period: Period, field: Field, value: string) => {
      const key = cellKey(partId, period, field)
      setStates((prev) => ({ ...prev, [key]: 'saving' }))

      const result = await saveMarketField({ partId, period, field, value })

      if (result.ok) {
        setStates((prev) => ({ ...prev, [key]: 'saved' }))
        setErrors((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        // Let the tick fade so the grid does not stay covered in checkmarks.
        setTimeout(() => {
          setStates((prev) => (prev[key] === 'saved' ? { ...prev, [key]: 'idle' } : prev))
        }, 1600)
      } else {
        setStates((prev) => ({ ...prev, [key]: 'error' }))
        setErrors((prev) => ({ ...prev, [key]: result.error }))
      }
    },
    [],
  )

  const onChange = useCallback(
    (partId: number, period: Period, field: Field, value: string) => {
      const key = cellKey(partId, period, field)
      setDrafts((prev) => ({ ...prev, [key]: value }))

      const existing = timers.current[key]
      if (existing) clearTimeout(existing)

      timers.current[key] = setTimeout(() => {
        delete timers.current[key]
        void commit(partId, period, field, value)
      }, DEBOUNCE_MS)
    },
    [commit],
  )

  /** Enter or blur saves right away rather than waiting out the debounce. */
  const flush = useCallback(
    (partId: number, period: Period, field: Field, value: string) => {
      const key = cellKey(partId, period, field)
      const existing = timers.current[key]
      if (!existing) return
      clearTimeout(existing)
      delete timers.current[key]
      void commit(partId, period, field, value)
    },
    [commit],
  )

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(
      (row) =>
        row.mpn.toLowerCase().includes(query) || row.description.toLowerCase().includes(query),
    )
  }, [rows, search])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No parts to track"
        body="Seed the catalogue with pnpm db:seed, or add parts from the Inventory page."
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
          {visible.length} parts — click a row to enter comps. Saves as you type.
        </span>
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
              <div key={period} className="text-center">
                {PERIOD_LABELS[period]}
              </div>
            ))}
          </div>

          {visible.map((row, index) => {
            const isOpen = open === row.partId

            return (
              <div
                key={row.partId}
                className={index < visible.length - 1 ? 'border-line border-b' : ''}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : row.partId)}
                  aria-expanded={isOpen}
                  className={`grid w-full items-center px-4 py-3 text-left transition-colors ${
                    isOpen ? 'bg-good/[0.05]' : index % 2 === 1 ? 'bg-white/[0.015]' : ''
                  } hover:bg-good/[0.04]`}
                  style={{ gridTemplateColumns: columns }}
                >
                  <span className="text-info font-mono text-xs">{row.mpn}</span>
                  <span className="text-ink truncate pr-4 text-sm">{row.description}</span>
                  <span className="text-ink-dim text-center font-mono text-sm">
                    {row.inventoryQty}
                  </span>
                  {PERIODS.map((period) => {
                    const observation = row.periods[period]
                    const total =
                      observation?.price == null
                        ? null
                        : observation.price + (observation.shipping ?? 0)
                    return (
                      <span
                        key={period}
                        className={`text-center font-mono text-xs ${
                          total == null ? 'text-ink-ghost' : 'text-ink'
                        }`}
                      >
                        {total == null ? '—' : money(total)}
                      </span>
                    )
                  })}
                </button>

                {isOpen && (
                  <div className="border-line bg-good/[0.03] border-t px-4 pt-3 pb-4">
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <span className="text-ink-faint text-xs tracking-widest uppercase">
                        Market data — {row.description}
                      </span>
                      <Link
                        href={`/inventory/${encodeURIComponent(row.mpn)}`}
                        className="text-info hover:text-good ml-auto font-mono text-xs transition-colors"
                      >
                        Charts &amp; history ↗
                      </Link>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="border-collapse text-sm" style={{ minWidth: 640 }}>
                        <thead>
                          <tr className="border-line border-b">
                            <th className="text-ink-faint w-28 pr-6 pb-2 text-left text-xs tracking-widest uppercase">
                              Period
                            </th>
                            <th className="text-ink-faint w-28 px-3 pb-2 text-right text-xs tracking-widest uppercase">
                              Price
                            </th>
                            <th className="text-ink-faint w-28 px-3 pb-2 text-right text-xs tracking-widest uppercase">
                              Shipping
                            </th>
                            <th className="text-ink-faint w-20 px-3 pb-2 text-right text-xs tracking-widest uppercase">
                              Qty
                            </th>
                            <th className="text-ink-faint w-24 px-3 pb-2 text-right text-xs tracking-widest uppercase">
                              Total
                            </th>
                            <th className="text-ink-faint px-3 pb-2 text-left text-xs tracking-widest uppercase">
                              Source
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {PERIODS.map((period) => {
                            const observation = row.periods[period]
                            const total =
                              observation?.price == null
                                ? null
                                : observation.price + (observation.shipping ?? 0)

                            return (
                              <tr key={period} className="border-line/50 border-b">
                                <td className="text-ink-dim pr-6 py-2 font-mono text-xs tracking-widest uppercase">
                                  {PERIOD_LABELS[period]}
                                </td>

                                {FIELDS.map((field) => {
                                  const key = cellKey(row.partId, period, field)
                                  const state = states[key] ?? 'idle'
                                  const stored = toInputValue(observation?.[field], field)
                                  const value = drafts[key] ?? stored

                                  return (
                                    <td key={field} className="px-3 py-1.5">
                                      <input
                                        type="number"
                                        min={0}
                                        step={field === 'qty' ? 1 : 0.01}
                                        inputMode="decimal"
                                        value={value}
                                        placeholder="—"
                                        aria-label={`${row.mpn} ${PERIOD_LABELS[period]} ${field}`}
                                        aria-invalid={state === 'error'}
                                        onChange={(event) =>
                                          onChange(row.partId, period, field, event.target.value)
                                        }
                                        onBlur={(event) =>
                                          flush(row.partId, period, field, event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') {
                                            event.preventDefault()
                                            flush(
                                              row.partId,
                                              period,
                                              field,
                                              event.currentTarget.value,
                                            )
                                          }
                                        }}
                                        className={`field w-full px-2 py-1 text-right font-mono text-xs outline-none focus:border-[var(--color-good)] ${
                                          state === 'error'
                                            ? 'border-[var(--color-bad)]'
                                            : state === 'saved'
                                              ? 'border-[var(--color-good)]'
                                              : ''
                                        }`}
                                      />
                                      {state === 'error' && errors[key] && (
                                        <span className="text-bad mt-0.5 block text-[10px]">
                                          {errors[key]}
                                        </span>
                                      )}
                                    </td>
                                  )
                                })}

                                <td
                                  className={`px-3 py-2 text-right font-mono text-xs ${
                                    total == null ? 'text-ink-ghost' : 'text-good'
                                  }`}
                                >
                                  {total == null ? '—' : money(total)}
                                </td>

                                <td className="px-3 py-2">
                                  {observation ? (
                                    <span className="flex items-center gap-1.5">
                                      <SourceBadge source={observation.source} />
                                      <span className="text-ink-faint font-mono text-[10px]">
                                        {relativeTime(observation.capturedAt)}
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
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
