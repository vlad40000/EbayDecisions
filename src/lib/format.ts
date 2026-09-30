const DASH = '—'

export function money(value: number | null | undefined, fallback = DASH): string {
  if (value == null || !Number.isFinite(value)) return fallback
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

export function percent(value: number | null | undefined, digits = 1, fallback = DASH): string {
  if (value == null || !Number.isFinite(value)) return fallback
  return `${value.toFixed(digits)}%`
}

/** Signed percent with a direction glyph, e.g. "▴ 4.2%". */
export function signedPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return DASH
  const glyph = value > 0 ? '▴' : value < 0 ? '▾' : '•'
  return `${glyph} ${Math.abs(value).toFixed(digits)}%`
}

export function integer(value: number | null | undefined, fallback = DASH): string {
  if (value == null || !Number.isFinite(value)) return fallback
  return String(Math.round(value))
}

/** Parses a form/DB string into a number, treating blank as null. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** For numeric DB columns, which drizzle returns as strings. */
export function toDbNumeric(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toFixed(2)
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return DASH
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return DASH
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}
