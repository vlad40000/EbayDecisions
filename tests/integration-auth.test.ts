import { NextRequest } from 'next/server'
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { config, proxy } from '../proxy'
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from '@/lib/auth'
import { checkIntegrationAuth } from '@/lib/integration-auth'

const KEY = 'integration-test-key-0123456789'

beforeEach(() => {
  process.env.AUTH_SECRET = 'auth-secret-for-tests-0123456789'
  process.env.INTEGRATION_API_KEY = KEY
})
afterEach(() => {
  delete process.env.INTEGRATION_API_KEY
})

describe('integration API key', () => {
  it('accepts only the exact bearer key', () => {
    expect(checkIntegrationAuth(`Bearer ${KEY}`)).toBe('ok')
    expect(checkIntegrationAuth(`bearer ${KEY}`)).toBe('ok')
    expect(checkIntegrationAuth(null)).toBe('unauthorized')
    expect(checkIntegrationAuth('')).toBe('unauthorized')
    expect(checkIntegrationAuth(KEY)).toBe('unauthorized')
    expect(checkIntegrationAuth(`Bearer ${KEY}x`)).toBe('unauthorized')
    expect(checkIntegrationAuth('Bearer wrong')).toBe('unauthorized')
  })

  it('is unavailable, not public, when the key is unset or too short', () => {
    delete process.env.INTEGRATION_API_KEY
    expect(checkIntegrationAuth(`Bearer ${KEY}`)).toBe('unconfigured')
    expect(checkIntegrationAuth(null)).toBe('unconfigured')
    process.env.INTEGRATION_API_KEY = 'short'
    expect(checkIntegrationAuth('Bearer short')).toBe('unconfigured')
  })
})

describe('browser session auth is unchanged', () => {
  it('still runs the session proxy on app pages and session API routes', () => {
    for (const url of ['/', '/inventory', '/tracker', '/api/parts/export', '/api/parts/import', '/api/ebay/sync']) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true)
    }
  })

  it('skips the session proxy only for login, cron, and the integration API', () => {
    for (const url of ['/login', '/api/cron/sync', '/api/integrations/market-facts']) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false)
    }
  })

  it('does not let the integration bearer key stand in for a browser session', () => {
    const request = new NextRequest('https://ebd.example/inventory', {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(getRedirectUrl(proxy(request))).toBe('https://ebd.example/login?from=%2Finventory')
  })

  it('still lets a signed session cookie through', () => {
    const { token } = createSessionToken()
    expect(verifySessionToken(token)).toBe(true)
    const request = new NextRequest('https://ebd.example/inventory', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    expect(getRedirectUrl(proxy(request))).toBeNull()
  })
})
