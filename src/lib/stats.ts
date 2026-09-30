export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown'

export type Trend = {
  direction: TrendDirection
  slope: number | null
  pctPer30d: number | null
  strong: boolean
  points: number
  spanDays: number
  qualified: boolean
}

const FLAT_THRESHOLD_PCT = 2
const STRONG_THRESHOLD_PCT = 6
const DAY_MS = 86_400_000

const EMPTY_TREND: Trend = {
  direction: 'unknown',
  slope: null,
  pctPer30d: null,
  strong: false,
  points: 0,
  spanDays: 0,
  qualified: false,
}

type XY = { x: number; y: number }

function fit(points: XY[], qualified: boolean, spanDays: number): Trend {
  const n = points.length
  if (n < 2) return { ...EMPTY_TREND, points: n, spanDays, qualified: false }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  if (denominator === 0) {
    return { ...EMPTY_TREND, points: n, spanDays, qualified: false }
  }

  const slope =
    points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) /
    denominator
  const pctPer30d = meanY !== 0 ? ((slope * 30) / Math.abs(meanY)) * 100 : null

  if (!qualified) {
    return { ...EMPTY_TREND, slope, pctPer30d, points: n, spanDays, qualified: false }
  }

  let direction: TrendDirection = 'flat'
  if (pctPer30d == null) {
    direction = slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat'
  } else if (Math.abs(pctPer30d) >= FLAT_THRESHOLD_PCT) {
    direction = pctPer30d > 0 ? 'rising' : 'falling'
  }

  return {
    direction,
    slope,
    pctPer30d,
    strong: pctPer30d != null && Math.abs(pctPer30d) >= STRONG_THRESHOLD_PCT,
    points: n,
    spanDays,
    qualified: true,
  }
}

/**
 * Trend across real calendar timestamps.
 *
 * Multiple observations on one UTC calendar date collapse to the latest one so
 * a correction saved minutes later cannot masquerade as a 30-day market move.
 * A history read is actionable only after at least 3 distinct dates spanning at
 * least 14 days; before that its slope is exposed for diagnostics but its
 * direction remains unknown.
 */
export function timeTrend(
  input: readonly { at: string | Date; value: number | null }[],
  options: { minPoints?: number; minSpanDays?: number } = {},
): Trend {
  const minPoints = options.minPoints ?? 3
  const minSpanDays = options.minSpanDays ?? 14

  const byDay = new Map<string, { at: number; value: number }>()
  for (const point of input) {
    if (point.value == null || !Number.isFinite(point.value)) continue
    const at = point.at instanceof Date ? point.at.getTime() : new Date(point.at).getTime()
    if (!Number.isFinite(at)) continue
    const day = new Date(at).toISOString().slice(0, 10)
    const existing = byDay.get(day)
    if (!existing || at >= existing.at) byDay.set(day, { at, value: point.value })
  }

  const values = [...byDay.values()].sort((a, b) => a.at - b.at)
  if (values.length < 2) return { ...EMPTY_TREND, points: values.length }

  const first = values[0]!.at
  const last = values[values.length - 1]!.at
  const spanDays = (last - first) / DAY_MS
  const points = values.map((point) => ({ x: (point.at - first) / DAY_MS, y: point.value }))
  return fit(points, values.length >= minPoints && spanDays >= minSpanDays, spanDays)
}

/**
 * Context-only curve across unequal lookback windows. x is real days from the
 * oldest reference point toward today, so 1yr→6m is not treated as the same
 * distance as 30d→7d. This is not a historical time series.
 */
export function spacedWindowTrend(
  input: readonly { daysAgo: number; value: number | null }[],
): Trend {
  const points = input
    .filter((point): point is { daysAgo: number; value: number } =>
      point.value != null && Number.isFinite(point.value),
    )
    .map((point) => ({ x: -point.daysAgo, y: point.value }))

  if (points.length < 2) return { ...EMPTY_TREND, points: points.length }
  const xs = points.map((point) => point.x)
  const spanDays = Math.max(...xs) - Math.min(...xs)
  // The window curve is always labelled separately; "qualified" only means the
  // arithmetic fit is usable, not that it is genuine longitudinal history.
  return fit(points, true, spanDays)
}

/** Fitted value at a given real-day x position for charting the window curve. */
export function trendValueAtX(
  input: readonly { x: number; value: number | null }[],
  trend: Trend,
  x: number,
): number | null {
  if (trend.slope == null) return null
  const points = input.filter(
    (point): point is { x: number; value: number } =>
      point.value != null && Number.isFinite(point.value),
  )
  if (points.length < 2) return null
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length
  const intercept = meanY - trend.slope * meanX
  return intercept + trend.slope * x
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
