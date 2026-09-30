import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { SESSION_COOKIE, verifySessionToken } from './auth'

export async function isSignedIn(): Promise<boolean> {
  const store = await cookies()
  return verifySessionToken(store.get(SESSION_COOKIE)?.value)
}

/**
 * Gate for every server component, server action and route handler that touches
 * data.
 *
 * `proxy.ts` already redirects unauthenticated page requests, but middleware is
 * a routing convenience, not a security boundary — a server action is reachable
 * by direct POST. So the check is repeated at the point of data access, which is
 * the only place it actually protects anything.
 */
export async function requireSession(): Promise<void> {
  if (!(await isSignedIn())) redirect('/login')
}

/** For API route handlers, which should answer 401 rather than redirect. */
export async function hasValidSession(): Promise<boolean> {
  return isSignedIn()
}
