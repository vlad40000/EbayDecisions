import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'ebd_session'

const TOKEN_VERSION = 'v1'

function authSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET is missing or too short. Generate one with `openssl rand -base64 48` and set it in your environment.',
    )
  }
  return secret
}

export function sessionDays(): number {
  const parsed = Number(process.env.SESSION_DAYS ?? '30')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30
}

function sign(payload: string): string {
  return createHmac('sha256', authSecret()).update(payload).digest('base64url')
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path costs the same as a mismatch
    // of equal length, then report false.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/** True when the submitted password matches APP_PASSWORD. */
export function checkPassword(submitted: string): boolean {
  const expected = process.env.APP_PASSWORD
  if (!expected || expected.length === 0) {
    throw new Error('APP_PASSWORD is not set, so sign-in is impossible. Set it in your environment.')
  }
  return safeEqual(submitted, expected)
}

/** Mints a signed session token that expires on its own. */
export function createSessionToken(now = Date.now()): { token: string; expiresAt: Date } {
  const expiresAtMs = now + sessionDays() * 24 * 60 * 60 * 1000
  const payload = `${TOKEN_VERSION}:${expiresAtMs}`
  return {
    token: `${expiresAtMs}.${sign(payload)}`,
    expiresAt: new Date(expiresAtMs),
  }
}

/**
 * Verifies a session token's signature and expiry.
 *
 * The expiry is inside the signed payload, so a client cannot extend its own
 * session by editing the cookie — any change breaks the HMAC.
 */
export function verifySessionToken(token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false

  const separator = token.lastIndexOf('.')
  if (separator <= 0) return false

  const expiresAtRaw = token.slice(0, separator)
  const signature = token.slice(separator + 1)

  const expiresAtMs = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAtMs)) return false

  if (!safeEqual(signature, sign(`${TOKEN_VERSION}:${expiresAtRaw}`))) return false

  return expiresAtMs > now
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  }
}
