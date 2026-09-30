import { describe, expect, it } from 'vitest'

import { titleMatchesMpn } from '@/lib/ebay/match'

describe('exact MPN qualification', () => {
  it('accepts exact and punctuation-separated part numbers', () => {
    expect(titleMatchesMpn('Genuine Whirlpool Control Board W11204517', 'W11204517')).toBe(true)
    expect(titleMatchesMpn('Control Board W112-04517 OEM', 'W11204517')).toBe(true)
    expect(titleMatchesMpn('w11204517 used board', 'W11204517')).toBe(true)
  })

  it('rejects a longer substring that only starts with the MPN', () => {
    expect(titleMatchesMpn('Board W112045170 replacement', 'W11204517')).toBe(false)
  })

  it('rejects unrelated titles', () => {
    expect(titleMatchesMpn('Whirlpool range control board W11100000', 'W11204517')).toBe(false)
  })
})
