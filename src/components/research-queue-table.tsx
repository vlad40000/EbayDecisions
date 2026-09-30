'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

import { Chip } from '@/components/ui'
import { money } from '@/lib/format'

export type ResearchQueueTableRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  lastResearchedAt: string | null
  ageDays: number | null
  sold30d: number | null
  avgSoldPrice: number | null
  researchState: 'never' | 'stale' | 'current'
}

const MAX_WORKING_SET = 20

function statusLabel(row: ResearchQueueTableRow) {
  if (row.researchState === 'never') return 'Never researched'
  if (row.researchState === 'stale') return 'Stale'
  return 'Current'
}

function lastResearched(row: ResearchQueueTableRow) {
  if (row.ageDays == null) return 'Never'
  if (row.ageDays === 0) return 'Today'
  if (row.ageDays === 1) return '1 day ago'
  return `${row.ageDays} days ago`
}

export function ResearchQueueTable({ rows }: { rows: ResearchQueueTableRow[] }) {
  const [selected, setSelected] = useState<string[]>([])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const visibleMpns = rows.map((row) => row.mpn)
  const allVisibleSelected =
    visibleMpns.length > 0 && visibleMpns.every((mpn) => selectedSet.has(mpn))

  function toggle(mpn: string) {
    setSelected((current) => {
      if (current.includes(mpn)) return current.filter((value) => value !== mpn)
      if (current.length >= MAX_WORKING_SET) return current
      return [...current, mpn]
    })
  }

  function toggleVisible() {
    setSelected((current) => {
      if (allVisibleSelected) return current.filter((mpn) => !visibleMpns.includes(mpn))
      const merged = [...current]
      for (const mpn of visibleMpns) {
        if (!merged.includes(mpn) && merged.length < MAX_WORKING_SET) merged.push(mpn)
      }
      return merged
    })
  }

  const trackerHref =
    selected.length > 0 ? `/tracker?mpns=${encodeURIComponent(selected.join(','))}` : '/tracker'

  return (
    <>
      <div className="bg-surface border-line mb-3 flex min-h-12 flex-wrap items-center gap-2 rounded border px-3 py-2">
        <span className="text-ink-faint text-xs">
          Working research set: <strong className="text-ink">{selected.length}</strong> / {MAX_WORKING_SET}
        </span>

        {selected.length > 0 && (
          <div className="flex flex-1 flex-wrap gap-1">
            {selected.map((mpn) => (
              <button
                key={mpn}
                type="button"
                onClick={() => toggle(mpn)}
                className="border-line text-ink-dim hover:text-ink rounded border px-1.5 py-0.5 font-mono text-[10px]"
                title="Remove from working set"
              >
                {mpn} ×
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="text-ink-faint hover:text-ink text-xs transition-colors"
            >
              Clear
            </button>
          )}
          <Link
            href={trackerHref}
            aria-disabled={selected.length === 0}
            className={
              selected.length === 0
                ? 'border-line text-ink-ghost pointer-events-none rounded border px-3 py-1.5 text-xs'
                : 'border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs font-medium transition-colors'
            }
          >
            Research selected
          </Link>
        </div>
      </div>

      {selected.length >= MAX_WORKING_SET && (
        <p className="text-warn mb-2 text-xs">
          Working sets are capped at {MAX_WORKING_SET} MPNs so research stays deliberate.
        </p>
      )}

      <div className="bg-surface border-line overflow-hidden rounded border">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" style={{ minWidth: 900 }}>
            <thead className="bg-surface-2">
              <tr className="border-line border-b">
                <th className="w-10 px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisible}
                    aria-label="Select visible MPNs"
                    className="accent-good"
                  />
                </th>
                <th className="text-ink-faint px-2 py-2 text-left text-xs font-medium tracking-widest uppercase">
                  MPN
                </th>
                <th className="text-ink-faint px-2 py-2 text-right text-xs font-medium tracking-widest uppercase">
                  Inv
                </th>
                <th className="text-ink-faint px-2 py-2 text-left text-xs font-medium tracking-widest uppercase">
                  Description
                </th>
                <th className="text-ink-faint px-2 py-2 text-left text-xs font-medium tracking-widest uppercase">
                  Last researched
                </th>
                <th className="text-ink-faint px-2 py-2 text-right text-xs font-medium tracking-widest uppercase">
                  30d sold
                </th>
                <th className="text-ink-faint px-2 py-2 text-right text-xs font-medium tracking-widest uppercase">
                  Avg sold
                </th>
                <th className="text-ink-faint px-2 py-2 text-left text-xs font-medium tracking-widest uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const checked = selectedSet.has(row.mpn)
                const tone =
                  row.researchState === 'never' ? 'dim' : row.researchState === 'stale' ? 'warn' : 'good'

                return (
                  <tr key={row.partId} className="border-line/60 border-b last:border-0">
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(row.mpn)}
                        aria-label={`Select ${row.mpn}`}
                        className="accent-good"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Link
                        href={`/inventory/${encodeURIComponent(row.mpn)}`}
                        className="text-info hover:text-good font-mono text-xs font-semibold transition-colors"
                      >
                        {row.mpn}
                      </Link>
                    </td>
                    <td className="text-ink px-2 py-2 text-right font-mono text-xs">
                      {row.inventoryQty}
                    </td>
                    <td className="text-ink-dim max-w-[320px] truncate px-2 py-2 text-xs">
                      {row.description}
                    </td>
                    <td className="text-ink-dim px-2 py-2 font-mono text-xs">
                      {lastResearched(row)}
                    </td>
                    <td className="text-ink px-2 py-2 text-right font-mono text-xs">
                      {row.sold30d ?? '—'}
                    </td>
                    <td className="text-ink px-2 py-2 text-right font-mono text-xs">
                      {money(row.avgSoldPrice)}
                    </td>
                    <td className="px-2 py-2">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Chip tone={tone}>{statusLabel(row)}</Chip>
                        {row.sold30d === 0 && <Chip tone="dim">Low activity</Chip>}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
