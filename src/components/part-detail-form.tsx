'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { removePart, savePartDetail, setPartActive } from '@/app/(app)/inventory/actions'
import { CATEGORIES } from '@/lib/categories'

import { Panel } from './ui'

export function PartDetailForm({
  partId,
  description,
  category,
  notes,
  sourceUrl,
  active,
}: {
  partId: number
  description: string
  category: string
  notes: string | null
  sourceUrl: string | null
  active: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [status, setStatus] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function save(formData: FormData) {
    setStatus(null)
    const result = await savePartDetail(formData)
    setStatus(
      result.ok
        ? { tone: 'good', text: 'Saved.' }
        : { tone: 'bad', text: result.error },
    )
    if (result.ok) startTransition(() => router.refresh())
  }

  async function toggleActive() {
    setStatus(null)
    const result = await setPartActive(partId, !active)
    if (result.ok) {
      startTransition(() => router.refresh())
    } else {
      setStatus({ tone: 'bad', text: result.error })
    }
  }

  async function destroy() {
    setStatus(null)
    const result = await removePart(partId)
    if (result.ok) {
      router.push('/inventory')
    } else {
      setStatus({ tone: 'bad', text: result.error })
    }
  }

  return (
    <Panel title="Part details">
      <form action={save} className="space-y-3">
        <input type="hidden" name="partId" value={partId} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">
              Description
            </span>
            <input
              name="description"
              defaultValue={description}
              required
              maxLength={200}
              className="field w-full px-2 py-1.5 text-xs outline-none focus:border-[var(--color-good)]"
            />
          </label>

          <label className="block">
            <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">
              Category
            </span>
            <select
              name="category"
              defaultValue={category}
              className="field w-full px-2 py-1.5 text-xs outline-none focus:border-[var(--color-good)]"
            >
              <option value="">Derive from description</option>
              {CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">
            Reference URL
          </span>
          <input
            name="sourceUrl"
            type="url"
            defaultValue={sourceUrl ?? ''}
            placeholder="https://…"
            className="field w-full px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-good)]"
          />
        </label>

        <label className="block">
          <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">
            Notes
          </span>
          <textarea
            name="notes"
            defaultValue={notes ?? ''}
            rows={3}
            maxLength={2000}
            placeholder="Which machine it came off, condition, tested or untested…"
            className="field w-full resize-y px-2 py-1.5 text-xs outline-none focus:border-[var(--color-good)]"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="border-good/40 bg-good/12 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
          >
            {pending ? 'Saving…' : 'Save details'}
          </button>

          <button
            type="button"
            onClick={toggleActive}
            disabled={pending}
            title={
              active
                ? 'Hide from the board and skip during sync, keeping its history.'
                : 'Bring it back onto the board.'
            }
            className="border-line bg-surface text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
          >
            {active ? 'Mark inactive' : 'Mark active'}
          </button>

          {status && (
            <span className={`text-xs ${status.tone === 'good' ? 'text-good' : 'text-bad'}`}>
              {status.text}
            </span>
          )}

          <span className="ml-auto">
            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-bad text-xs">Delete this part and its history?</span>
                <button
                  type="button"
                  onClick={destroy}
                  className="border-bad/40 bg-bad/12 text-bad hover:bg-bad/20 rounded border px-2.5 py-1 text-xs transition-colors"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-ink-faint hover:text-ink text-xs transition-colors"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-ink-faint hover:text-bad text-xs transition-colors"
              >
                Delete part
              </button>
            )}
          </span>
        </div>
      </form>
    </Panel>
  )
}
