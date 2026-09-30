import { PERIOD_DAYS, PERIODS, type EconomicSettings, type PartWithMarket, type Period, type TrendBasis, type TrendSummary } from './types'
import { spacedWindowTrend, type TrendDirection } from './stats'

export type Action = 'LIST_NOW' | 'LIST' | 'HOLD' | 'WATCH' | 'DUMP' | 'NEEDS_DATA'

export const ACTION_LABELS: Record<Action, string> = {
  LIST_NOW: 'List now',
  LIST: 'List',
  HOLD: 'Hold',
  WATCH: 'Watch',
  DUMP: 'Dump',
  NEEDS_DATA: 'Needs data',
}

export const ACTION_PRIORITY: Record<Action, number> = {
  LIST_NOW: 0,
  DUMP: 1,
  LIST: 2,
  WATCH: 3,
  HOLD: 4,
  NEEDS_DATA: 5,
}

export type Economics = {
  price: number
  shipping: number
  grossOrder: number
  fees: number
  shipCost: number
  netProceeds: number
  marginDollars: number | null
  marginPct: number | null
  roiPct: number | null
}

export type TrendRead = {
  direction: TrendDirection
  pctPer30d: number | null
  points: number
  spanDays: number
  strong: boolean
  basis: TrendBasis
  period: Period | null
}

export type Decision = {
  action: Action
  reason: string
  notes: string[]
  economics: Economics | null
  suggestedListPrice: number | null
  potentialDollars: number | null
  marketTrend: TrendRead
  demandTrend: TrendRead
  supplyTrend: TrendRead
  targetMarginPct: number
  provenance: 'sold' | 'asking' | 'mixed' | 'unknown'
  currentMarketKind: 'window' | 'active' | 'none'
}

export function computeEconomics(args: {
  price: number
  shipping: number
  costBasis: number | null
  shipCost: number | null
  settings: EconomicSettings
}): Economics {
  const shipCost = args.shipCost ?? args.settings.defaultShipCost
  const grossOrder = args.price + args.shipping
  const fees = grossOrder * (args.settings.feePct / 100) + args.settings.feeFixed
  const netProceeds = grossOrder - fees - shipCost
  const marginDollars = args.costBasis == null ? null : netProceeds - args.costBasis
  const marginPct =
    marginDollars == null || netProceeds <= 0 ? null : (marginDollars / netProceeds) * 100
  const roiPct =
    marginDollars == null || args.costBasis == null || args.costBasis <= 0
      ? null
      : (marginDollars / args.costBasis) * 100

  return {
    price: args.price,
    shipping: args.shipping,
    grossOrder,
    fees,
    shipCost,
    netProceeds,
    marginDollars,
    marginPct,
    roiPct,
  }
}

export function suggestedListPrice(args: {
  costBasis: number | null
  shipping: number
  shipCost: number | null
  targetMarginPct: number
  settings: EconomicSettings
}): number | null {
  if (args.costBasis == null) return null
  const margin = args.targetMarginPct / 100
  const fee = args.settings.feePct / 100
  if (margin >= 1 || fee >= 1) return null

  const shipCost = args.shipCost ?? args.settings.defaultShipCost
  const requiredNet = args.costBasis / (1 - margin)
  const price =
    (requiredNet + args.settings.feeFixed + shipCost) / (1 - fee) - args.shipping
  return price > 0 ? price : null
}

function totalCost(observation: { price: number | null; shipping: number | null }): number | null {
  if (observation.price == null) return null
  return observation.price + (observation.shipping ?? 0)
}

function directionFromPct(pct: number | null): TrendDirection {
  if (pct == null) return 'unknown'
  if (Math.abs(pct) < 2) return 'flat'
  return pct > 0 ? 'rising' : 'falling'
}

function historicalRead(args: {
  pctPer30d: number | null
  points: number
  spanDays: number
  period?: Period | null
}): TrendRead {
  const qualified = args.points >= 3 && args.spanDays >= 14 && args.pctPer30d != null
  return {
    direction: qualified ? directionFromPct(args.pctPer30d) : 'unknown',
    pctPer30d: args.pctPer30d,
    points: args.points,
    spanDays: args.spanDays,
    strong: qualified && Math.abs(args.pctPer30d ?? 0) >= 6,
    basis: qualified ? 'history' : 'insufficient',
    period: args.period ?? null,
  }
}

function marketWindowCurve(part: PartWithMarket): TrendRead {
  const trend = spacedWindowTrend(
    PERIODS.map((period) => ({
      daysAgo: PERIOD_DAYS[period],
      value: part.periods[period] ? totalCost(part.periods[period]!) : null,
    })),
  )
  return {
    direction: trend.direction,
    pctPer30d: trend.pctPer30d,
    points: trend.points,
    spanDays: trend.spanDays,
    strong: trend.strong,
    basis: trend.points >= 2 ? 'window-curve' : 'insufficient',
    period: null,
  }
}

/**
 * Demand fallback compares sales velocity, not raw nested-window counts.
 * 8 sales in 7 days is stronger demand than 20 in 30 days, even though 8 < 20.
 */
function demandWindowVelocity(part: PartWithMarket): TrendRead {
  const trend = spacedWindowTrend(
    PERIODS.map((period) => ({
      daysAgo: PERIOD_DAYS[period],
      value:
        part.periods[period]?.soldQty == null
          ? null
          : part.periods[period]!.soldQty! / PERIOD_DAYS[period],
    })),
  )
  return {
    direction: trend.direction,
    pctPer30d: trend.pctPer30d,
    points: trend.points,
    spanDays: trend.spanDays,
    strong: trend.strong,
    basis: trend.points >= 2 ? 'window-velocity' : 'insufficient',
    period: null,
  }
}

function provenance(part: PartWithMarket): Decision['provenance'] {
  const bases = PERIODS.map((period) => part.periods[period])
    .filter((observation) => observation?.price != null)
    .map((observation) => observation!.priceBasis)

  if (bases.length === 0 && part.activeMarket?.askingPrice != null) return 'asking'
  const known = bases.filter((basis) => basis !== 'unknown')
  if (known.length === 0) return bases.length > 0 ? 'unknown' : 'unknown'
  const unique = new Set(known)
  if (unique.size > 1 || bases.includes('unknown')) return 'mixed'
  return unique.has('sold') ? 'sold' : 'asking'
}

function currentMarket(part: PartWithMarket): {
  price: number
  shipping: number
  kind: 'window' | 'active'
} | null {
  for (let i = PERIODS.length - 1; i >= 0; i -= 1) {
    const observation = part.periods[PERIODS[i] as Period]
    if (observation?.price != null) {
      return {
        price: observation.price,
        shipping: observation.shipping ?? 0,
        kind: 'window',
      }
    }
  }

  if (part.activeMarket?.askingPrice != null) {
    return {
      price: part.activeMarket.askingPrice,
      shipping: part.activeMarket.askingShipping ?? 0,
      kind: 'active',
    }
  }
  return null
}

export function decide(
  part: PartWithMarket,
  settings: EconomicSettings,
  summary?: TrendSummary,
): Decision {
  const target = part.targetMarginPct ?? settings.targetMarginPct
  const min = settings.minMarginPct

  const historyMarket = historicalRead({
    pctPer30d: summary?.marketPctPer30d ?? null,
    points: summary?.marketPoints ?? 0,
    spanDays: summary?.marketSpanDays ?? 0,
    period: summary?.marketPeriod ?? null,
  })
  const marketTrend = historyMarket.basis === 'history' ? historyMarket : marketWindowCurve(part)

  const historyDemand = historicalRead({
    pctPer30d: summary?.demandPctPer30d ?? null,
    points: summary?.demandPoints ?? 0,
    spanDays: summary?.demandSpanDays ?? 0,
    period: summary?.demandPeriod ?? null,
  })
  const demandTrend = historyDemand.basis === 'history' ? historyDemand : demandWindowVelocity(part)

  const supplyTrend = historicalRead({
    pctPer30d: summary?.supplyPctPer30d ?? null,
    points: summary?.supplyPoints ?? 0,
    spanDays: summary?.supplySpanDays ?? 0,
  })

  const current = currentMarket(part)
  const readProvenance = provenance(part)
  const base = {
    marketTrend,
    demandTrend,
    supplyTrend,
    targetMarginPct: target,
    provenance: readProvenance,
    currentMarketKind: current?.kind ?? ('none' as const),
  }

  if (!current) {
    return {
      ...base,
      action: 'NEEDS_DATA',
      reason: 'No market price data yet — enter a sold comp or preview active eBay listings.',
      notes: [],
      economics: null,
      suggestedListPrice: null,
      potentialDollars: null,
    }
  }

  const economics = computeEconomics({
    price: current.price,
    shipping: current.shipping,
    costBasis: part.costBasis,
    shipCost: part.shipCost,
    settings,
  })
  const suggested = suggestedListPrice({
    costBasis: part.costBasis,
    shipping: current.shipping,
    shipCost: part.shipCost,
    targetMarginPct: target,
    settings,
  })

  const notes: string[] = []
  if (marketTrend.basis !== 'history') {
    if (marketTrend.basis === 'window-curve') {
      notes.push('Historical captures are not mature yet; the shown price direction is only the current lookback-window curve and does not drive the verdict.')
    } else {
      notes.push('Price history needs at least 3 distinct capture dates spanning 14 days before it can drive a verdict.')
    }
  }
  if (demandTrend.basis === 'window-velocity') {
    notes.push('Demand history is not mature yet; the fallback compares sold units per day across the unequal lookback windows.')
  }
  if (supplyTrend.basis !== 'history') {
    notes.push('Competitive-supply trend needs at least 3 active-listing captures spanning 14 days.')
  }
  if (readProvenance === 'asking' || current.kind === 'active') {
    notes.push('Current economics use active-listing asking prices, not completed sales.')
  } else if (readProvenance === 'mixed') {
    notes.push('The visible price windows mix sold, asking, or unknown-basis observations.')
  } else if (readProvenance === 'unknown') {
    notes.push('At least one manual price has an unknown sold/asking basis.')
  }
  if (part.shipCost == null) {
    notes.push(`Using the default $${settings.defaultShipCost.toFixed(2)} actual ship cost.`)
  }
  if (supplyTrend.basis === 'history' && supplyTrend.strong && supplyTrend.direction === 'rising') {
    notes.push(`Active competing supply is rising ${Math.abs(supplyTrend.pctPer30d ?? 0).toFixed(1)}% per 30 days.`)
  }
  if (demandTrend.basis === 'history' && demandTrend.strong && demandTrend.direction === 'rising') {
    notes.push(`Sold velocity is rising ${Math.abs(demandTrend.pctPer30d ?? 0).toFixed(1)}% per 30 days.`)
  }

  const marginDollars = economics.marginDollars
  const marginPct = economics.marginPct
  const potentialDollars = marginDollars == null ? null : marginDollars * part.inventoryQty
  const result = {
    ...base,
    economics,
    notes,
    suggestedListPrice: suggested,
    potentialDollars,
  }

  if (part.costBasis == null) {
    return {
      ...result,
      action: 'NEEDS_DATA',
      reason: `Market is $${economics.grossOrder.toFixed(2)}, but there is no cost basis, so margin is unknown.`,
    }
  }

  const marginText = marginPct == null ? 'n/a' : `${marginPct.toFixed(1)}%`
  const marketHistoryIsActionable = marketTrend.basis === 'history'
  const supplyHistoryIsActionable = supplyTrend.basis === 'history'
  const demandHistoryIsActionable = demandTrend.basis === 'history'
  const marketMove = Math.abs(marketTrend.pctPer30d ?? 0).toFixed(1)

  if (marginDollars != null && marginDollars < 0) {
    return {
      ...result,
      action: 'DUMP',
      reason: `Underwater: $${economics.netProceeds.toFixed(2)} net against a $${part.costBasis.toFixed(2)} cost basis loses $${Math.abs(marginDollars).toFixed(2)} per unit.`,
    }
  }

  if (marginPct != null && marginPct < min) {
    if (marketHistoryIsActionable && marketTrend.direction === 'falling') {
      return {
        ...result,
        action: 'DUMP',
        reason: `Margin ${marginText} is below the ${min.toFixed(0)}% floor and qualified sold-price history is falling ${marketMove}% per 30 days.`,
      }
    }
    if (marketHistoryIsActionable && marketTrend.direction === 'rising') {
      return {
        ...result,
        action: 'HOLD',
        reason: `Margin ${marginText} is below the ${min.toFixed(0)}% floor, but qualified sold-price history is rising ${marketMove}% per 30 days.`,
      }
    }
    return {
      ...result,
      action: 'WATCH',
      reason: `Margin ${marginText} is below the ${min.toFixed(0)}% floor, but there is not yet qualified historical price direction to justify a dump or hold call.`,
    }
  }

  if (marginPct != null && marginPct >= target) {
    if (marketHistoryIsActionable && marketTrend.direction === 'falling') {
      return {
        ...result,
        action: 'LIST_NOW',
        reason: `Margin ${marginText} clears the ${target.toFixed(0)}% target while qualified sold-price history is falling ${marketMove}% per 30 days.`,
      }
    }
    if (supplyHistoryIsActionable && supplyTrend.strong && supplyTrend.direction === 'rising') {
      return {
        ...result,
        action: 'LIST_NOW',
        reason: `Margin ${marginText} clears target while qualified active-listing history shows competition rising quickly.`,
      }
    }
    if (
      (marketHistoryIsActionable && marketTrend.strong && marketTrend.direction === 'rising') ||
      (demandHistoryIsActionable && demandTrend.strong && demandTrend.direction === 'rising')
    ) {
      return {
        ...result,
        action: 'HOLD',
        reason: `Margin ${marginText} clears target and qualified history is strengthening without a falling sold-price trend.`,
      }
    }
    return {
      ...result,
      action: 'LIST',
      reason: `Margin ${marginText} meets the ${target.toFixed(0)}% target. No qualified historical signal currently overrides the economics.`,
    }
  }

  if (marketHistoryIsActionable && marketTrend.direction === 'rising') {
    return {
      ...result,
      action: 'HOLD',
      reason: `Margin ${marginText} is between the floor and target, while qualified sold-price history is rising ${marketMove}% per 30 days.`,
    }
  }
  if (marketHistoryIsActionable && marketTrend.direction === 'falling') {
    return {
      ...result,
      action: 'LIST',
      reason: `Margin ${marginText} is workable, while qualified sold-price history is falling ${marketMove}% per 30 days.`,
    }
  }
  return {
    ...result,
    action: 'WATCH',
    reason: `Margin ${marginText} is between the ${min.toFixed(0)}% floor and ${target.toFixed(0)}% target without enough qualified history to force timing.`,
  }
}

export function compareDecisions(
  a: { decision: Decision },
  b: { decision: Decision },
): number {
  const byAction = ACTION_PRIORITY[a.decision.action] - ACTION_PRIORITY[b.decision.action]
  if (byAction !== 0) return byAction
  return Math.abs(b.decision.potentialDollars ?? 0) - Math.abs(a.decision.potentialDollars ?? 0)
}
