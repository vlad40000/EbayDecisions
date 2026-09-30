'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { savePartFields } from '@/app/(app)/inventory/actions'

import { Chip, EmptyState } from './ui'

export type PartsTableRow = {
  partId: number
  mpn: string
  description: string
  category: string
  inventoryQty: number
  sourceUrl: string | null
  active: boolean
}

type Drafts = Record<number, string>
type RowState = 'idle' | 'saving' | 'saved' | 'error'

export function PartsTable({ rows }: { rows: PartsTableRow[] }) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<Drafts>({})
  const [states, setStates] = useState<Record<number, RowState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})

  const pendingCount = useMemo(() => Object.keys(drafts).length, [drafts])

  useEffect(() => {
    if (pendingCount === 0) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pendingCount])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No inventory rows match this view"
        body="Change the search or filters, or add an MPN."
      />
    )
  }

  async function saveQty(row: PartsTableRow) {
    const draft = drafts[row.partId]
    if (draft === undefined) return

    setStates((previous) => ({ ...previous, [row.partId]: 'saving' }))
    const result = await savePartFields({ partId: row.partId, inventoryQty: draft })

    if (!result.ok) {
      setStates((previous) => ({ ...previous, [row.partId]: 'error' }))
      setErrors((previous) => ({ ...previous, [row.partId]: result.error }))
      return
    }

    setDrafts((previous) => {
      const next = { ...previous }
      delete next[row.partId]
      return next
    })
    setErrors((previous) => {
      const next = { ...previous }
      delete next[row.partId]
      return next
    })
    setStates((previous) => ({ ...previous, [row.partId]: 'saved' }))
    router.refresh()
  }

  return (
    <div>
      {pendingCount > 0 && (
        <div className="text-warn mb-2 font-mono text-xs">
          ● {pendingCount} unsaved inventory row{pendingCount === 1 ? '' : 's'}
        </div>
      )}

      <div className="border-line overflow-x-auto rounded border">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 760 }}>
          <caption className="sr-only">Inventory context with explicit quantity saves.</caption>
          <thead>
            <tr className="bg-surface border-line border-b">
              {['MPN', 'Description', 'Category', 'Qty on hand', 'Save', 'Reference'].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={`text-ink-faint px-3 py-2.5 text-xs font-medium tracking-widest whitespace-nowrap uppercase ${
                    index >= 3 && index <= 4 ? 'text-right' : 'text-left'
                  }`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const draft = drafts[row.partId]
              const state = states[row.partId] ?? 'idle'
              const unsaved = draft !== undefined

              return (
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
                    {unsaved && <span className="text-warn ml-1" title="Unsaved">●</span>}
                  </td>
                  <td className="text-ink max-w-80 truncate px-3 py-2">{row.description}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5">
                      <Chip>{row.category}</Chip>
                      {!row.active && <Chip tone="warn">Inactive</Chip>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={draft ?? String(row.inventoryQty)}
                      onChange={(event) =>
                        setDrafts((previous) => ({ ...previous, [row.partId]: event.target.value }))
                      }
                      aria-label={`${row.mpn} quantity on hand`}
                      className="field w-20 px-2 py-1 text-right font-mono text-xs outline-none focus:border-[var(--color-good)]"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void saveQty(row)}
                      disabled={!unsaved || state === 'saving'}
                      className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-2.5 py-1.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Save Qty'}
                    </button>
                    {state === 'error' && (
                      <div className="text-bad mt-1 max-w-48 text-right text-[10px]">
                        {errors[row.partId]}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.sourceUrl ? (
                      <a
                        href={row.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ink-faint hover:text-info font-mono text-xs transition-colors"
                      >
                        ref ↗
                      </a>
                    ) : (
                      <span className="text-ink-ghost">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-ink-faint mt-3 text-xs">
        Inventory changes are explicit. Quantity edits stay local until <strong>Save Qty</strong>.
        Market research belongs in Market Tracker; operational listing/sales state belongs in Roadrunner Parts Ledger.
      </p>
    </div>
  )
}
