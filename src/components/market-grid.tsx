'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { saveMarketWindows, type WindowInput } from '@/app/(app)/tracker/actions'
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

/**
 * Long enough that typing across a part's fifteen cells settles into one save,
 * short enough that a save still feels immediate when you move on.
 */
const DEBOUNCE_MS = 900

type PartState = 'idle' | 'saving' | 'saved' | 'error'

const cellKey = (period: Period, field: Field) => `${period}:${field}`

function toInputValue(value: number | null | undefined, field: Field): string {
  if (value == null) return ''
  return field === 'qty' ? String(Math.round(value)) : value.toFixed(2)
}

/** Per-part drafts: the cells edited since the last successful save. */
type Drafts = Record<number, Record<string, string>>

export function MarketGrid({ rows }: { rows: GridRow[] }) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  /*
   * Edits live here while you type, so a server round-trip can never yank a
   * value out from under the cursor. A part's drafts clear only when its save
   * succeeds, which is what hands the cell back to the stored value.
   */
  const [drafts, setDrafts] = useState<Drafts>({})
  const [states, setStates] = useState<Record<number, PartState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})

  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  /*
   * A mirror of `drafts` that the debounced callback can read. The callback
   * fires long after the render that scheduled it, so closing over `drafts`
   * directly would send whatever had been typed at schedule time and silently
   * drop every keystroke after it. Synced in an effect rather than during
   * render, which commits before any of the flush paths can run.
   */
  const draftsRef = useRef<Drafts>(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  const pendingCount = useMemo(
    () => Object.values(drafts).filter((part) => Object.keys(part).length > 0).length,
    [drafts],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of Object.values(pending)) clearTimeout(timer)
    }
  }, [])

  // A save is at most a second away, but a tab closed inside that second would
  // lose it silently. Worth one confirm dialog.
  useEffect(() => {
    if (pendingCount === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pendingCount])

  const commit = useCallback(async (partId: number) => {
    const partDrafts = draftsRef.current[partId]
    if (!partDrafts || Object.keys(partDrafts).length === 0) return

    // Group the edited cells into one payload per touched window. Untouched
    // fields are deliberately absent so the server carries forward whatever is
    // current rather than taking a stale copy from this browser.
    const byPeriod = new Map<Period, WindowInput>()
    for (const [key, value] of Object.entries(partDrafts)) {
      const [period, field] = key.split(':') as [Period, Field]
      const window = byPeriod.get(period) ?? { period }
      window[field] = value
      byPeriod.set(period, window)
    }

    const sent = { ...partDrafts }
    setStates((prev) => ({ ...prev, [partId]: 'saving' }))

    const result = await saveMarketWindows({ partId, windows: [...byPeriod.values()] })

    if (result.ok) {
      setStates((prev) => ({ ...prev, [partId]: 'saved' }))
      setErrors((prev) => {
        const next = { ...prev }
        delete next[partId]
        return next
      })
      // Drop only what was sent — anything typed during the round-trip stays
      // pending and gets picked up by its own save.
      setDrafts((prev) => {
        const remaining = { ...(prev[partId] ?? {}) }
        for (const key of Object.keys(sent)) {
          if (remaining[key] === sent[key]) delete remaining[key]
        }
        return { ...prev, [partId]: remaining }
      })
      setTimeout(() => {
        setStates((prev) => (prev[partId] === 'saved' ? { ...prev, [partId]: 'idle' } : prev))
      }, 1800)
    } else {
      setStates((prev) => ({ ...prev, [partId]: 'error' }))
      setErrors((prev) => ({ ...prev, [partId]: result.error }))
    }
  }, [])

  const schedule = useCallback(
    (partId: number) => {
      const existing = timers.current[partId]
      if (existing) clearTimeout(existing)
      timers.current[partId] = setTimeout(() => {
        delete timers.current[partId]
        void commit(partId)
      }, DEBOUNCE_MS)
    },
    [commit],
  )

  const onChange = useCallback(
    (partId: number, period: Period, field: Field, value: string) => {
      setDrafts((prev) => ({
        ...prev,
        [partId]: { ...(prev[partId] ?? {}), [cellKey(period, field)]: value },
      }))
      schedule(partId)
    },
    [schedule],
  )

  /** Saves the part now rather than waiting out the debounce. */
  const flush = useCallback(
    (partId: number) => {
      const existing = timers.current[partId]
      if (!existing) return
      clearTimeout(existing)
      delete timers.current[partId]
      void commit(partId)
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

  /** The value a cell shows: the draft while editing, otherwise what is stored. */
  const displayed = (row: GridRow, period: Period, field: Field): string => {
    const draft = drafts[row.partId]?.[cellKey(period, field)]
    return draft ?? toInputValue(row.periods[period]?.[field], field)
  }

  /** Row total, computed from drafts so the summary tracks what you type. */
  const displayedTotal = (row: GridRow, period: Period): number | null => {
    const price = Number(displayed(row, period, 'price'))
    if (!Number.isFinite(price) || displayed(row, period, 'price') === '') return null
    const shippingRaw = displayed(row, period, 'shipping')
    const shipping = shippingRaw === '' ? 0 : Number(shippingRaw)
    return price + (Number.isFinite(shipping) ? shipping : 0)
  }

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
        {pendingCount > 0 && (
          <span className="text-warn font-mono text-xs" role="status">
            ● {pendingCount} saving…
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
              <div key={period} className="text-center">
                {PERIOD_LABELS[period]}
              </div>
            ))}
          </div>

          {visible.map((row, index) => {
            const isOpen = open === row.partId
            const state = states[row.partId] ?? 'idle'
            const unsaved = Object.keys(drafts[row.partId] ?? {}).length > 0

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
                  <span className="text-info flex items-center gap-1.5 font-mono text-xs">
                    {row.mpn}
                    {unsaved && (
                      <span className="text-warn" title="Unsaved edits">
                        ●
                      </span>
                    )}
                    {state === 'error' && (
                      <span className="text-bad" title="Save failed">
                        !
                      </span>
                    )}
                  </span>
                  <span className="text-ink truncate pr-4 text-sm">{row.description}</span>
                  <span className="text-ink-dim text-center font-mono text-sm">
                    {row.inventoryQty}
                  </span>
                  {PERIODS.map((period) => {
                    const total = displayedTotal(row, period)
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
                  <div
                    className="border-line bg-good/[0.03] border-t px-4 pt-3 pb-4"
                    /*
                     * React's onBlur is focusout, so it bubbles. Tabbing from one
                     * cell to the next within this part keeps the batch open;
                     * only focus actually leaving the part flushes it. Putting
                     * this on each input instead sent one request per cell.
                     */
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget)) return
                      flush(row.partId)
                    }}
                  >
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <span className="text-ink-faint text-xs tracking-widest uppercase">
                        Market data — {row.description}
                      </span>

                      <span
                        role="status"
                        className={`font-mono text-xs ${
                          state === 'error'
                            ? 'text-bad'
                            : state === 'saved'
                              ? 'text-good'
                              : 'text-ink-faint'
                        }`}
                      >
                        {state === 'saving'
                          ? 'Saving…'
                          : state === 'saved'
                            ? 'Saved'
                            : state === 'error'
                              ? (errors[row.partId] ?? 'Save failed')
                              : unsaved
                                ? 'Unsaved'
                                : ''}
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
                            const total = displayedTotal(row, period)

                            return (
                              <tr key={period} className="border-line/50 border-b">
                                <td className="text-ink-dim py-2 pr-6 font-mono text-xs tracking-widest uppercase">
                                  {PERIOD_LABELS[period]}
                                </td>

                                {FIELDS.map((field) => (
                                  <td key={field} className="px-3 py-1.5">
                                    <input
                                      type="number"
                                      min={0}
                                      step={field === 'qty' ? 1 : 0.01}
                                      inputMode="decimal"
                                      value={displayed(row, period, field)}
                                      placeholder="—"
                                      aria-label={`${row.mpn} ${PERIOD_LABELS[period]} ${field}`}
                                      aria-invalid={state === 'error'}
                                      onChange={(event) =>
                                        onChange(row.partId, period, field, event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                          event.preventDefault()
                                          flush(row.partId)
                                        }
                                      }}
                                      className={`field w-full px-2 py-1 text-right font-mono text-xs outline-none focus:border-[var(--color-good)] ${
                                        state === 'error' ? 'border-[var(--color-bad)]' : ''
                                      }`}
                                    />
                                  </td>
                                ))}

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
