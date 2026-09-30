export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown'

export type Trend = {
  direction: TrendDirection
  /** Least-squares slope in raw units per period step. */
  slope: number | null
  /** Slope as a percent of the series mean — comparable across parts. */
  pctPerPeriod: number | null
  /** True when the move is large enough to act on. */
  strong: boolean
  /** How many points the fit used. Below 3, treat the read as weak. */
  points: number
}

const FLAT_THRESHOLD_PCT = 2
const STRONG_THRESHOLD_PCT = 6

const EMPTY_TREND: Trend = {
  direction: 'unknown',
  slope: null,
  pctPerPeriod: null,
  strong: false,
  points: 0,
}

/**
 * Ordinary least-squares slope over a series indexed 0..n-1.
 *
 * Nulls are dropped, and the surviving points keep their *original* spacing —
 * so a part missing its 6-month reading does not get a falsely steep slope from
 * having its remaining points bunched together.
 */
export function linearTrend(series: readonly (number | null)[]): Trend {
  const points: { x: number; y: number }[] = []
  series.forEach((y, x) => {
    if (y != null && Number.isFinite(y)) points.push({ x, y })
  })

  const n = points.length
  if (n < 2) return { ...EMPTY_TREND, points: n }

  const meanX = points.reduce((a, p) => a + p.x, 0) / n
  const meanY = points.reduce((a, p) => a + p.y, 0) / n

  const denominator = points.reduce((a, p) => a + (p.x - meanX) ** 2, 0)
  if (denominator === 0) return { ...EMPTY_TREND, points: n }

  const slope = points.reduce((a, p) => a + (p.x - meanX) * (p.y - meanY), 0) / denominator

  // Normalising by the mean makes a $2/period move on a $30 gasket comparable
  // to a $2/period move on a $200 board.
  const pctPerPeriod = meanY !== 0 ? (slope / Math.abs(meanY)) * 100 : null

  let direction: TrendDirection = 'flat'
  if (pctPerPeriod == null) {
    direction = slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat'
  } else if (Math.abs(pctPerPeriod) >= FLAT_THRESHOLD_PCT) {
    direction = pctPerPeriod > 0 ? 'rising' : 'falling'
  }

  return {
    direction,
    slope,
    pctPerPeriod,
    strong: pctPerPeriod != null && Math.abs(pctPerPeriod) >= STRONG_THRESHOLD_PCT,
    points: n,
  }
}

/** Fitted value at index i, for drawing the trend line alongside the data. */
export function trendValueAt(
  series: readonly (number | null)[],
  trend: Trend,
  index: number,
): number | null {
  if (trend.slope == null) return null
  const points: { x: number; y: number }[] = []
  series.forEach((y, x) => {
    if (y != null && Number.isFinite(y)) points.push({ x, y })
  })
  if (points.length < 2) return null
  const meanX = points.reduce((a, p) => a + p.x, 0) / points.length
  const meanY = points.reduce((a, p) => a + p.y, 0) / points.length
  const intercept = meanY - trend.slope * meanX
  return intercept + trend.slope * index
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
