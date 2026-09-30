'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { addPart } from '@/app/(app)/inventory/actions'

export function AddPartForm() {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function submit(formData: FormData) {
    setError(null)
    setAdded(null)
    const mpn = String(formData.get('mpn') ?? '')
    const result = await addPart(formData)
    if (result.ok) {
      setAdded(mpn)
      formRef.current?.reset()
      startTransition(() => router.refresh())
    } else {
      setError(result.error)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-line bg-surface text-ink-dim hover:text-ink rounded border px-3 py-1.5 text-xs transition-colors"
      >
        + Add a part
      </button>
    )
  }

  return (
    <form
      ref={formRef}
      action={submit}
      className="bg-surface border-line w-full rounded border p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-ink-faint text-xs font-medium tracking-widest uppercase">
          Add a part
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink text-xs transition-colors"
        >
          Close
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="MPN" required>
          <input
            name="mpn"
            required
            maxLength={64}
            placeholder="W11170706"
            className="field w-full px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-good)]"
          />
        </Field>

        <Field label="Description" required className="lg:col-span-2">
          <input
            name="description"
            required
            maxLength={200}
            placeholder="Washer Control Board"
            className="field w-full px-2 py-1.5 text-xs outline-none focus:border-[var(--color-good)]"
          />
        </Field>

        <Field label="Qty on hand">
          <input
            name="inventoryQty"
            type="number"
            min={0}
            step={1}
            defaultValue={1}
            className="field w-full px-2 py-1.5 text-right font-mono text-xs outline-none focus:border-[var(--color-good)]"
          />
        </Field>

        <Field label="Cost basis">
          <input
            name="costBasis"
            type="number"
            min={0}
            step={0.01}
            placeholder="optional"
            className="field w-full px-2 py-1.5 text-right font-mono text-xs outline-none focus:border-[var(--color-good)]"
          />
        </Field>

        <Field label="Reference URL" className="sm:col-span-2 lg:col-span-4">
          <input
            name="sourceUrl"
            type="url"
            placeholder="https://…"
            className="field w-full px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-good)]"
          />
        </Field>

        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="border-good/40 bg-good/12 text-good hover:bg-good/20 w-full rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
          >
            {pending ? 'Adding…' : 'Add part'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-bad mt-3 text-xs">
          {error}
        </p>
      )}
      {added && (
        <p role="status" className="text-good mt-3 text-xs">
          Added {added}. Set its market comps in the Tracker.
        </p>
      )}
    </form>
  )
}

function Field({
  label,
  children,
  required,
  className = '',
}: {
  label: string
  children: React.ReactNode
  required?: boolean
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">
        {label}
        {required && <span className="text-bad ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}
