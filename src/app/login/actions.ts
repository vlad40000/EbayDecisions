'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import {
  SESSION_COOKIE,
  checkPassword,
  createSessionToken,
  sessionCookieOptions,
} from '@/lib/auth'

/** Only ever redirect to a path inside this app. */
function safeReturnTo(raw: FormDataEntryValue | null): string {
  const value = typeof raw === 'string' ? raw : ''
  if (!value.startsWith('/') || value.startsWith('//')) return '/decisions'
  return value
}

export async function signIn(formData: FormData) {
  const submitted = formData.get('password')
  const returnTo = safeReturnTo(formData.get('from'))

  if (typeof submitted !== 'string' || submitted.length === 0) {
    redirect('/login?error=invalid')
  }

  let ok = false
  try {
    ok = checkPassword(submitted)
  } catch {
    // APP_PASSWORD or AUTH_SECRET missing on the server.
    redirect('/login?error=unconfigured')
  }

  if (!ok) redirect('/login?error=invalid')

  const { token, expiresAt } = createSessionToken()
  const store = await cookies()
  store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))

  redirect(returnTo)
}
