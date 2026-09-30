'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { savePartFields } from '@/app/(app)/inventory/actions'
import { CATEGORIES } from '@/lib/categories'
import { money } from '@/lib/format'

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
  marketTotal: number | null
}

type Field = 'inventoryQty' | 'costBasis' | 'shipCost' | 'targetMarginPct'
type Drafts = Record<number, Partial<Record<Field, string>>>
type RowState = 'idle' | 'saving' | 'saved' | 'error'

function format(value: number | null, decimals = 2) {
  if (value == null) return ''
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals)
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
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [onlyMissingCost, setOnlyMissingCost] = useState(false)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [states, setStates] = useState<Record<number, RowState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})

  const categories = useMemo(() => {
    const present = new Set(rows.map((row) => row.category))
    return ['All', ...CATEGORIES.filter((c) => present.has(c))]
  }, [rows])
  const missingCostCount = useMemo(() => rows.filter((row) => row.costBasis == null).length, [rows])
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
    return rows.filter((row) => {
      if (category !== 'All' && row.category !== category) return false
      if (onlyMissingCost && row.costBasis != null) return false
      if (!query) return true
      return row.mpn.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
    })
  }, [rows, search, category, onlyMissingCost])

  if (rows.length === 0) {
    return <EmptyState title="No parts in the catalogue" body="Run pnpm db:seed to load the 63 MPNs, or add one below." />
  }

  const setDraft = (partId: number, field: Field, value: string) => {
    setDrafts((previous) => ({
      ...previous,
      [partId]: { ...(previous[partId] ?? {}), [field]: value },
    }))
    setStates((previous) => ({ ...previous, [partId]: 'idle' }))
  }

  const displayed = (row: PartsTableRow, field: Field): string => {
    const draft = drafts[row.partId]?.[field]
    if (draft !== undefined) return draft
    if (field === 'inventoryQty') return format(row.inventoryQty, 0)
    if (field === 'costBasis') return format(row.costBasis)
    if (field === 'shipCost') return format(row.shipCost)
    return format(row.targetMarginPct, 0)
  }

  const saveRow = async (row: PartsTableRow) => {
    const draft = drafts[row.partId]
    if (!draft || Object.keys(draft).length === 0) return
    setStates((previous) => ({ ...previous, [row.partId]: 'saving' }))
    const result = await savePartFields({ partId: row.partId, ...draft })
    if (!result.ok) {
      setStates((previous) => ({ ...previous, [row.partId]: 'error' }))
      setErrors((previous) => ({ ...previous, [row.partId]: result.error }))
      return
    }
    setDrafts((previous) => ({ ...previous, [row.partId]: {} }))
    setErrors((previous) => {
      const next = { ...previous }
      delete next[row.partId]
      return next
    })
    setStates((previous) => ({ ...previous, [row.partId]: 'saved' }))
    router.refresh()
    setTimeout(() => setStates((previous) => previous[row.partId] === 'saved' ? { ...previous, [row.partId]: 'idle' } : previous), 1600)
  }

  const totalUnits = rows.reduce((total, row) => total + row.inventoryQty, 0)

  return (
    <div>
      <div className="border-line mb-5 flex flex-wrap gap-6 border-b pb-4">
        <Stat label="Unique MPNs" value={String(rows.length)} />
        <Divider />
        <Stat label="Total units" value={String(totalUnits)} />
        <Divider />
        <Stat label="Missing cost" value={String(missingCostCount)} tone={missingCostCount > 0 ? 'warn' : 'good'} />
        <Divider />
        <Stat label="Unsaved" value={String(pendingCount)} tone={pendingCount > 0 ? 'warn' : 'neutral'} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search MPN or description…" aria-label="Search parts" className="field min-w-52 flex-1 px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-good)]" />
        <div className="flex flex-wrap gap-1.5">
          {categories.map((option) => (
            <button key={option} type="button" onClick={() => setCategory(option)} aria-pressed={category === option} className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${category === option ? 'border-good/40 bg-good/15 text-good' : 'border-line bg-surface text-ink-dim hover:text-ink'}`}>{option}</button>
          ))}
        </div>
        <label className="text-ink-dim flex cursor-pointer items-center gap-1.5 text-xs">
          <input type="checkbox" checked={onlyMissingCost} onChange={(event) => setOnlyMissingCost(event.target.checked)} className="accent-good" />
          Missing cost only
        </label>
      </div>

      <div className="border-line overflow-x-auto rounded border">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 1040 }}>
          <caption className="sr-only">Parts catalogue with explicit per-row saves.</caption>
          <thead>
            <tr className="bg-surface border-line border-b">
              {['MPN','Description','Category','Qty','Cost basis','Ship cost','Target %','Market','Save',''].map((label, index) => (
                <th key={`${label}-${index}`} scope="col" className={`text-ink-faint px-3 py-2.5 text-xs font-medium tracking-widest whitespace-nowrap uppercase ${index >= 3 ? 'text-right' : 'text-left'}`}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
              const unsaved = Object.keys(drafts[row.partId] ?? {}).length > 0
              const state = states[row.partId] ?? 'idle'
              return (
                <tr key={row.partId} className={`border-line border-b ${index % 2 === 1 ? 'bg-white/[0.015]' : ''}`}>
                  <td className="px-3 py-2"><Link href={`/inventory/${encodeURIComponent(row.mpn)}`} className="text-info hover:text-good font-mono text-xs transition-colors">{row.mpn}</Link>{unsaved && <span className="text-warn ml-1" title="Unsaved">●</span>}</td>
                  <td className="text-ink max-w-64 truncate px-3 py-2">{row.description}</td>
                  <td className="px-3 py-2"><Chip>{row.category}</Chip></td>
                  <td className="px-3 py-2 text-right"><NumberField label={`${row.mpn} quantity`} value={displayed(row,'inventoryQty')} onChange={(value) => setDraft(row.partId,'inventoryQty',value)} integer width="w-14" /></td>
                  <td className="px-3 py-2 text-right"><NumberField label={`${row.mpn} cost basis`} value={displayed(row,'costBasis')} onChange={(value) => setDraft(row.partId,'costBasis',value)} prefix="$" /></td>
                  <td className="px-3 py-2 text-right"><NumberField label={`${row.mpn} ship cost`} value={displayed(row,'shipCost')} onChange={(value) => setDraft(row.partId,'shipCost',value)} prefix="$" placeholder={defaultShipCost.toFixed(2)} /></td>
                  <td className="px-3 py-2 text-right"><NumberField label={`${row.mpn} target margin`} value={displayed(row,'targetMarginPct')} onChange={(value) => setDraft(row.partId,'targetMarginPct',value)} integer suffix="%" width="w-14" placeholder={defaultTargetMarginPct.toFixed(0)} /></td>
                  <td className={`px-3 py-2 text-right font-mono text-xs ${row.marketTotal == null ? 'text-ink-ghost' : 'text-ink'}`}>{money(row.marketTotal)}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => void saveRow(row)} disabled={!unsaved || state === 'saving'} className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-2.5 py-1.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-35">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Save Part'}</button>
                    {state === 'error' && <div className="text-bad mt-1 max-w-40 text-right text-[10px]">{errors[row.partId]}</div>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{row.sourceUrl && <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-ink-faint hover:text-info font-mono text-xs transition-colors">ref ↗</a>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && <p className="text-ink-faint py-6 text-center text-sm">Nothing matches that filter.</p>}
      <p className="text-ink-faint mt-3 text-xs">Inventory edits stay local until <strong>Save Part</strong>. One row save becomes one database update. Blank ship cost uses the ${defaultShipCost.toFixed(2)} default; blank target uses {defaultTargetMarginPct.toFixed(0)}%. Cost basis <span className="font-mono">0</span> remains distinct from blank/unknown.</p>
    </div>
  )
}

function NumberField({ label, value, onChange, integer = false, prefix, suffix, placeholder = '—', width = 'w-20' }: { label: string; value: string; onChange: (value: string) => void; integer?: boolean; prefix?: string; suffix?: string; placeholder?: string; width?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {prefix && <span className="text-ink-faint font-mono text-xs">{prefix}</span>}
      <input type="number" min={0} step={integer ? 1 : 0.01} inputMode={integer ? 'numeric' : 'decimal'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} className={`field ${width} px-2 py-1 text-right font-mono text-xs outline-none focus:border-[var(--color-good)]`} />
      {suffix && <span className="text-ink-faint font-mono text-xs">{suffix}</span>}
    </span>
  )
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'warn' }) {
  const valueTone = { neutral: 'text-ink', good: 'text-good', warn: 'text-warn' }[tone]
  return <div><div className="text-ink-faint mb-0.5 text-xs tracking-widest uppercase">{label}</div><div className={`font-mono text-2xl font-semibold ${valueTone}`}>{value}</div></div>
}

function Divider() { return <div className="bg-line w-px" aria-hidden /> }
