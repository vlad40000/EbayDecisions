import { describe, expect, it } from 'vitest'

import { buildActiveSearchParams } from '@/lib/ebay/browse'

describe('MPN-only Active research', () => {
  it('uses only the supplied MPN plus pagination mechanics', () => {
    const params = buildActiveSearchParams('  W11204517  ')

    expect(params).toEqual({
      q: 'W11204517',
      limit: '200',
    })
    expect(params).not.toHaveProperty('filter')
    expect(params).not.toHaveProperty('category_ids')
    expect(params).not.toHaveProperty('aspect_filter')
  })
})
