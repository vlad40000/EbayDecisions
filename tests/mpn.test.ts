import { describe, expect, it } from 'vitest'

import { MARKET_FACTS_MAX_MPNS, parseMarketFactsRequest } from '@/lib/market-facts'
import { toMpnKey } from '@/lib/mpn'

describe('D1 MPN key', () => {
  it('trims, uppercases, and strips every non-alphanumeric character', () => {
    expect(toMpnKey('DC47-00019A')).toBe('DC4700019A')
    expect(toMpnKey('  w11567368 ')).toBe('W11567368')
    expect(toMpnKey('a.b_c#d(e)f+g\th i')).toBe('ABCDEFGHI')
    expect(toMpnKey('---')).toBe('')
  })

  it('collapses punctuation and case variants to the same key', () => {
    const variants = ['DC47-00019A', 'dc47 00019a', 'DC47/00019A', ' dc47.00019-a ']
    expect(new Set(variants.map(toMpnKey))).toEqual(new Set(['DC4700019A']))
  })

  it('keeps superseding / replacement MPNs as different keys', () => {
    expect(toMpnKey('W10295370')).not.toBe(toMpnKey('W10295370A'))
    expect(toMpnKey('DC47-00019A')).not.toBe(toMpnKey('DC47-00019B'))
  })
})

describe('market facts request parsing', () => {
  it('dedupes equivalent spellings in first-seen order and drops blank keys', () => {
    expect(
      parseMarketFactsRequest({ mpns: ['W11567368', 'DC47-00019A', 'dc47 00019a', '---', '', 'w11567368'] }),
    ).toEqual({ ok: true, keys: ['W11567368', 'DC4700019A'] })
  })

  it('rejects more than the batch limit and malformed bodies', () => {
    const tooMany = Array.from({ length: MARKET_FACTS_MAX_MPNS + 1 }, (_, i) => `P${i}`)
    expect(parseMarketFactsRequest({ mpns: tooMany }).ok).toBe(false)
    expect(parseMarketFactsRequest({ mpns: tooMany.slice(1) }).ok).toBe(true)
    expect(parseMarketFactsRequest({}).ok).toBe(false)
    expect(parseMarketFactsRequest({ mpns: 'W11567368' }).ok).toBe(false)
    expect(parseMarketFactsRequest({ mpns: [42] }).ok).toBe(false)
    expect(parseMarketFactsRequest(null).ok).toBe(false)
  })
})
