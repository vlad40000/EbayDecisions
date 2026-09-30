'use client'

import Link from 'next/link'
import { Fragment, useMemo, useState } from 'react'

import { ACTION_LABELS, ACTION_PRIORITY, type Action } from '@/lib/decisions'
import { money, percent, signedPercent } from '@/lib/format'
import type { TrendBasis } from '@/lib/types'

import { ActionBadge, Chip, EmptyState } from './ui'

export type BoardRow = {
  mpn: string
  description: string
  category: string
  inventoryQty: number
  costBasis: number | null
  marketPrice: number | null
  marketShipping: number | null
  netProceeds: number | null
  marginDollars: number | null
  marginPct: number | null
  potentialDollars: number | null
  suggestedListPrice: number | null
  marketTrendDirection: 'rising' | 'falling' | 'flat' | 'unknown'
  marketTrendPct: number | null
  marketTrendBasis: TrendBasis
  demandTrendDirection: 'rising' | 'falling' | 'flat' | 'unknown'
  demandTrendPct: number | null
  supplyTrendDirection: 'rising' | 'falling' | 'flat' | 'unknown'
  supplyTrendPct: number | null
  action: Action
  reason: string
  notes: string[]
  provenance: 'sold' | 'asking' | 'mixed' | 'unknown'
}

type SortKey = 'recommended' | 'potential' | 'margin' | 'mpn'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'potential', label: '$ at stake' },
  { key: 'margin', label: 'Margin %' },
  { key: 'mpn', label: 'MPN' },
]

function trendTone(direction: BoardRow['marketTrendDirection']) {
  return direction === 'rising' ? 'text-good' : direction === 'falling' ? 'text-bad' : 'text-ink-faint'
}

export function DecisionBoard({ rows }: { rows: BoardRow[] }) {
  const [actionFilter, setActionFilter] = useState<Action | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('recommended')
  const [expanded, setExpanded] = useState<string | null>(null)

  const counts = useMemo(() => {
    const tally = new Map<Action, number>()
    for (const row of rows) tally.set(row.action, (tally.get(row.action) ?? 0) + 1)
    return tally
  }, [rows])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = rows.filter((row) => {
      if (actionFilter !== 'ALL' && row.action !== actionFilter) return false
      if (!query) return true
      return (
        row.mpn.toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query) ||
        row.category.toLowerCase().includes(query)
      )
    })

    return [...filtered].sort((a, b) => {
      if (sort === 'potential') return Math.abs(b.potentialDollars ?? 0) - Math.abs(a.potentialDollars ?? 0)
      if (sort === 'margin') return (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)
      if (sort === 'mpn') return a.mpn.localeCompare(b.mpn)
      const byAction = ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action]
      return byAction !== 0 ? byAction : Math.abs(b.potentialDollars ?? 0) - Math.abs(a.potentialDollars ?? 0)
    })
  }, [rows, actionFilter, search, sort])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No parts yet"
        body="Seed the catalogue with pnpm db:seed, or add parts one at a time from Inventory."
        cta={{ href: '/inventory', label: 'Go to Inventory' }}
      />
    )
  }

  const filterOptions: (Action | 'ALL')[] = [
    'ALL',
    ...(['LIST_NOW', 'DUMP', 'LIST', 'WATCH', 'HOLD', 'NEEDS_DATA'] as Action[]).filter(
      (action) => (counts.get(action) ?? 0) > 0,
    ),
  ]

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search MPN, description, category…"
          aria-label="Search parts"
          className="field min-w-56 flex-1 px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-good)]"
        />

        <div className="flex flex-wrap gap-1.5">
          {filterOptions.map((option) => {
            const active = actionFilter === option
            const count = option === 'ALL' ? rows.length : (counts.get(option) ?? 0)
            return (
              <button
                key={option}
                type="button"
                onClick={() => setActionFilter(option)}
                aria-pressed={active}
                className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
                  active
                    ? 'border-good/40 bg-good/15 text-good'
                    : 'border-line bg-surface text-ink-dim hover:text-ink'
                }`}
              >
                {option === 'ALL' ? 'All' : ACTION_LABELS[option]}{' '}
                <span className="font-mono opacity-60">{count}</span>
              </button>
            )
          })}
        </div>

        <label className="text-ink-faint ml-auto flex items-center gap-1.5 text-xs">
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="field px-2 py-1 font-mono text-xs outline-none"
          >
            {SORTS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="border-line overflow-x-auto rounded border">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 980 }}>
          <caption className="sr-only">Listing recommendations with economics and qualified market signals.</caption>
          <thead>
            <tr className="bg-surface border-line border-b">
              {['Action', 'MPN', 'Description', 'Qty', 'Cost', 'Market', 'Net', 'Margin', 'Price trend', 'At stake'].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={`text-ink-faint px-3 py-2.5 text-xs font-medium tracking-widest whitespace-nowrap uppercase ${index >= 3 ? 'text-right' : 'text-left'}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
              const open = expanded === row.mpn
              return (
                <Fragment key={row.mpn}>
                  <tr
                    onClick={() => setExpanded(open ? null : row.mpn)}
                    className={`border-line hover:bg-good/[0.04] cursor-pointer border-b transition-colors ${
                      index % 2 === 1 ? 'bg-white/[0.015]' : ''
                    } ${open ? 'bg-good/[0.05]' : ''}`}
                  >
                    <td className="px-3 py-2.5"><ActionBadge action={row.action} /></td>
                    <td className="text-info px-3 py-2.5 font-mono text-xs whitespace-nowrap">{row.mpn}</td>
                    <td className="text-ink max-w-64 truncate px-3 py-2.5">{row.description}</td>
                    <td className="text-ink-dim px-3 py-2.5 text-right font-mono">{row.inventoryQty}</td>
                    <td className="text-ink-dim px-3 py-2.5 text-right font-mono text-xs">{money(row.costBasis)}</td>
                    <td className="text-ink px-3 py-2.5 text-right font-mono text-xs">
                      {row.marketPrice == null ? '—' : money(row.marketPrice + (row.marketShipping ?? 0))}
                    </td>
                    <td className="text-ink px-3 py-2.5 text-right font-mono text-xs">{money(row.netProceeds)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      <span className={row.marginDollars == null ? 'text-ink-ghost' : row.marginDollars < 0 ? 'text-bad' : 'text-good'}>
                        {money(row.marginDollars)}
                      </span>
                      <span className="text-ink-faint ml-1.5">{percent(row.marginPct, 0)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {row.marketTrendDirection === 'unknown' ? (
                        <span className="text-ink-ghost font-mono text-xs">—</span>
                      ) : (
                        <span className={`font-mono text-xs ${trendTone(row.marketTrendDirection)}`}>
                          {signedPercent(row.marketTrendPct)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      <span className={row.potentialDollars == null ? 'text-ink-ghost' : row.potentialDollars < 0 ? 'text-bad' : 'text-ink'}>
                        {money(row.potentialDollars)}
                      </span>
                    </td>
                  </tr>

                  {open && (
                    <tr className="border-line bg-good/[0.03] border-b">
                      <td colSpan={10} className="px-4 py-3">
                        <p className="text-ink mb-2 text-sm">{row.reason}</p>
                        {row.notes.length > 0 && (
                          <ul className="text-ink-dim mb-3 space-y-0.5 text-xs">
                            {row.notes.map((note) => <li key={note}>· {note}</li>)}
                          </ul>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          {row.suggestedListPrice != null && (
                            <Chip tone="info">List at {money(row.suggestedListPrice)} for target margin</Chip>
                          )}
                          <Chip tone={row.provenance === 'sold' ? 'good' : row.provenance === 'asking' ? 'warn' : 'dim'}>
                            Price basis: {row.provenance}
                          </Chip>
                          <Chip tone={row.marketTrendBasis === 'history' ? 'good' : 'dim'}>
                            Price {row.marketTrendBasis}: {signedPercent(row.marketTrendPct)} / 30d
                          </Chip>
                          <Chip tone="dim">Demand: {signedPercent(row.demandTrendPct)} / 30d</Chip>
                          <Chip tone="dim">Supply: {signedPercent(row.supplyTrendPct)} / 30d</Chip>
                          <Link
                            href={`/inventory/${encodeURIComponent(row.mpn)}`}
                            className="text-info hover:text-good ml-auto font-mono text-xs transition-colors"
                          >
                            Open part detail ↗
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && (
        <p className="text-ink-faint py-6 text-center text-sm">Nothing matches that filter.</p>
      )}
    </div>
  )
}
