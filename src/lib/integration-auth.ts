import 'server-only'

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Service-to-service auth for /api/integrations/*, independent of the signed
 * browser session. The caller sends `Authorization: Bearer <INTEGRATION_API_KEY>`.
 *
 * - `unconfigured`: INTEGRATION_API_KEY is unset or shorter than 16 characters,
 *   so the endpoint is unavailable rather than accidentally public.
 * - `unauthorized`: the header is missing or the key is wrong.
 *
 * Neither the configured key nor the submitted one is ever logged or echoed.
 */
export type IntegrationAuthResult = 'ok' | 'unconfigured' | 'unauthorized'

const MIN_KEY_LENGTH = 16

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function checkIntegrationAuth(authorization: string | null): IntegrationAuthResult {
  const expected = process.env.INTEGRATION_API_KEY
  if (!expected || expected.length < MIN_KEY_LENGTH) return 'unconfigured'

  const match = /^Bearer (.+)$/i.exec(authorization ?? '')
  const provided = match?.[1]
  if (!provided) return 'unauthorized'

  // Comparing fixed-length digests keeps the check constant-time regardless of
  // the submitted key's length.
  return timingSafeEqual(digest(provided), digest(expected)) ? 'ok' : 'unauthorized'
}
