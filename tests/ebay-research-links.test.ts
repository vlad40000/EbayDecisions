import { describe, expect, it } from 'vitest'

import {
  buildEbayActiveResearchUrl,
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

  it('only trims the supplied MPN', () => {
    expect(normalizeResearchMpn('  WPW10562155  ')).toBe('WPW10562155')
  })
})
