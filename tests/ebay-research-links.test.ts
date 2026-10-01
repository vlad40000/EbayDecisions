import { describe, expect, it } from 'vitest'

import {
  buildEbayActiveResearchUrl,
  buildEbayProductResearchUrl,
  buildEbaySoldResearchUrl,
  normalizeResearchMpn,
} from '@/lib/ebay/research-links'

describe('MPN-only eBay research links', () => {
  it('uses only the supplied MPN for active research', () => {
    const url = new URL(buildEbayActiveResearchUrl('  WE01X24552  '))

    expect(url.hostname).toBe('www.ebay.com')
    expect(url.pathname).toBe('/sch/i.html')
    expect(url.searchParams.get('_nkw')).toBe('WE01X24552')
    expect([...url.searchParams.keys()]).toEqual(['_nkw'])
  })

  it('uses only the same supplied MPN for completed/sold research', () => {
    const url = new URL(buildEbaySoldResearchUrl('W11204517'))

    expect(url.searchParams.get('_nkw')).toBe('W11204517')
    expect(url.searchParams.get('LH_Sold')).toBe('1')
    expect(url.searchParams.get('LH_Complete')).toBe('1')
    expect([...url.searchParams.keys()].sort()).toEqual(['LH_Complete', 'LH_Sold', '_nkw'].sort())
  })

  it('does not add brand, model, description, or compatibility text', () => {
    const url = decodeURIComponent(buildEbaySoldResearchUrl('WP694089'))

    expect(url).toContain('_nkw=WP694089')
    expect(url).not.toContain('Whirlpool')
    expect(url).not.toContain('dryer')
    expect(url).not.toContain('model')
    expect(url).not.toContain('compatible')
  })

  it('builds MPN-only Seller Hub Product Research links for every lookback window', () => {
    const nowMs = new Date('2026-10-01T12:00:00.000Z').getTime()
    const expectedDays = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
      '6m': 182,
      '1yr': 365,
    } as const

    for (const [period, days] of Object.entries(expectedDays)) {
      const url = new URL(
        buildEbayProductResearchUrl('  W11204517  ', period as keyof typeof expectedDays, nowMs),
      )

      expect(url.hostname).toBe('www.ebay.com')
      expect(url.pathname).toBe('/sh/research')
      expect(url.searchParams.get('keywords')).toBe('W11204517')
      expect(url.searchParams.get('dayRange')).toBe(String(days))
      expect(url.searchParams.get('categoryId')).toBe('0')
      expect(url.searchParams.get('tabName')).toBe('SOLD')
      expect(url.searchParams.get('marketplace')).toBe('EBAY-US')
      expect(Number(url.searchParams.get('endDate'))).toBe(nowMs)
      expect(Number(url.searchParams.get('startDate'))).toBe(nowMs - days * 86_400_000)

      const decoded = decodeURIComponent(url.toString())
      expect(decoded).not.toContain('Whirlpool')
      expect(decoded).not.toContain('dryer')
      expect(decoded).not.toContain('compatible')
    }
  })

  it('only trims the supplied MPN', () => {
    expect(normalizeResearchMpn('  WPW10562155  ')).toBe('WPW10562155')
  })
})
