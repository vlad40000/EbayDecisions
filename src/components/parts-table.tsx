'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

import { savePartField } from '@/app/(app)/inventory/actions'
import { CATEGORIES } from '@/lib/categories'
import { money } from '@/lib/format'

import { InlineNumber } from './inline-number'
import { Chip, EmptyState } from './ui'

export type PartsTableRow = {
  partId: number
  mpn: string
  description: string
  category: string
  inventoryQty: number
  costBasis: number | null
  shipCost: number | null
  targetMarginPct: number | null
  sourceUrl: string | null
  /** Latest market total (price + shipping), for context while entering cost. */
  marketTotal: number | null
}

export function PartsTable({
  rows,
  defaultShipCost,
  defaultTargetMarginPct,
}: {
  rows: PartsTableRow[]
  defaultShipCost: number
  defaultTargetMarginPct: number
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [onlyMissingCost, setOnlyMissingCost] = useState(false)

  const categories = useMemo(() => {
    const present = new Set(rows.map((row) => row.category))
    return ['All', ...CATEGORIES.filter((c) => present.has(c))]
  }, [rows])

  const missingCostCount = useMemo(
    () => rows.filter((row) => row.costBasis == null).length,
    [rows],
  )

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (category !== 'All' && row.category !== category) return false
      if (onlyMissingCost && row.costBasis != null) return false
      if (!query) return true
      return (
        row.mpn.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
      )
    })
  }, [rows, search, category, onlyMissingCost])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No parts in the catalogue"
        body="Run pnpm db:seed to load the 63 MPNs from the spreadsheet, or add one below."
      />
    )
  }

  const totalUnits = rows.reduce((total, row) => total + row.inventoryQty, 0)

  return (
    <div>
      <div className="border-line mb-5 flex flex-wrap gap-6 border-b pb-4">
        <Stat label="Unique MPNs" value={String(rows.length)} />
        <Divider />
        <Stat label="Total units" value={String(totalUnits)} />
        <Divider />
        <Stat
          label="Missing cost"
          value={String(missingCostCount)}
          tone={missingCostCount > 0 ? 'warn' : 'good'}
        />
        <Divider />
        <Stat label="Showing" value={String(visible.length)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search MPN or description…"
          aria-label="Search parts"
          className="field min-w-52 flex-1 px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-good)]"
        />

        <div className="flex flex-wrap gap-1.5">
          {categories.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setCategory(option)}
              aria-pressed={category === option}
              className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
                category === option
                  ? 'border-good/40 bg-good/15 text-good'
                  : 'border-line bg-surface text-ink-dim hover:text-ink'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <label className="text-ink-dim flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={onlyMissingCost}
            onChange={(event) => setOnlyMissingCost(event.target.checked)}
            className="accent-good"
          />
          Missing cost only
        </label>
      </div>

      <div className="border-line overflow-x-auto rounded border">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 940 }}>
          <caption className="sr-only">
            Parts catalogue with editable cost basis, ship cost, target margin and quantity.
          </caption>
          <thead>
            <tr className="bg-surface border-line border-b">
              {[
                { label: 'MPN', align: 'left' },
                { label: 'Description', align: 'left' },
                { label: 'Category', align: 'left' },
                { label: 'Qty', align: 'right' },
                { label: 'Cost basis', align: 'right' },
                { label: 'Ship cost', align: 'right' },
                { label: 'Target %', align: 'right' },
                { label: 'Market', align: 'right' },
                { label: '', align: 'right' },
              ].map((header) => (
                <th
                  key={header.label || 'links'}
                  scope="col"
                  className={`text-ink-faint px-3 py-2.5 text-xs font-medium tracking-widest whitespace-nowrap uppercase ${
                    header.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {header.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={row.partId}
                className={`border-line border-b ${index % 2 === 1 ? 'bg-white/[0.015]' : ''}`}
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/inventory/${encodeURIComponent(row.mpn)}`}
                    className="text-info hover:text-good font-mono text-xs transition-colors"
                  >
                    {row.mpn}
                  </Link>
                </td>
                <td className="text-ink max-w-64 truncate px-3 py-2">{row.description}</td>
                <td className="px-3 py-2">
                  <Chip>{row.category}</Chip>
                </td>
                <td className="px-3 py-2 text-right">
                  <InlineNumber
                    label={`${row.mpn} quantity on hand`}
                    storedValue={row.inventoryQty}
                    step={1}
                    decimals={0}
                    width="w-14"
                    allowBlank={false}
                    onSave={(value) =>
                      savePartField({ partId: row.partId, field: 'inventoryQty', value })
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <InlineNumber
                    label={`${row.mpn} cost basis`}
                    storedValue={row.costBasis}
                    prefix="$"
                    onSave={(value) =>
                      savePartField({ partId: row.partId, field: 'costBasis', value })
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <InlineNumber
                    label={`${row.mpn} ship cost`}
                    storedValue={row.shipCost}
                    prefix="$"
                    placeholder={defaultShipCost.toFixed(2)}
                    onSave={(value) =>
                      savePartField({ partId: row.partId, field: 'shipCost', value })
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <InlineNumber
                    label={`${row.mpn} target margin percent`}
                    storedValue={row.targetMarginPct}
                    step={1}
                    decimals={0}
                    width="w-14"
                    suffix="%"
                    placeholder={defaultTargetMarginPct.toFixed(0)}
                    onSave={(value) =>
                      savePartField({ partId: row.partId, field: 'targetMarginPct', value })
                    }
                  />
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono text-xs ${
                    row.marketTotal == null ? 'text-ink-ghost' : 'text-ink'
                  }`}
                >
                  {money(row.marketTotal)}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {row.sourceUrl && (
                    <a
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open the reference page for this part"
                      className="text-ink-faint hover:text-info font-mono text-xs transition-colors"
                    >
                      ref ↗
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && (
        <p className="text-ink-faint py-6 text-center text-sm">Nothing matches that filter.</p>
      )}

      <p className="text-ink-faint mt-3 text-xs">
        Blank ship cost falls back to the ${defaultShipCost.toFixed(2)} default; blank target margin
        falls back to {defaultTargetMarginPct.toFixed(0)}%. Both are set on the Settings page. A
        cost basis of <span className="font-mono">0</span> is meaningful — a part pulled off a
        scrapped machine — and is treated differently from a blank one.
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn'
}) {
  const valueTone = { neutral: 'text-ink', good: 'text-good', warn: 'text-warn' }[tone]
  return (
    <div>
      <div className="text-ink-faint mb-0.5 text-xs tracking-widest uppercase">{label}</div>
      <div className={`font-mono text-2xl font-semibold ${valueTone}`}>{value}</div>
    </div>
  )
}

function Divider() {
  return <div className="bg-line w-px" aria-hidden />
}
