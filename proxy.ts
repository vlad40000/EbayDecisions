import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth'

/**
 * Cheap redirect for unauthenticated page loads, so a signed-out visitor never
 * sees a flash of the app shell.
 *
 * This is a convenience, not the security boundary. Every server action and
 * route handler re-checks the session at the point it touches data — see
 * `requireSession` in src/lib/session.ts.
 *
 * Renamed from `middleware.ts` in Next.js 16; the proxy runtime is nodejs, which
 * is what lets this verify the cookie's HMAC directly.
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value

  let valid = false
  try {
    valid = verifySessionToken(token)
  } catch {
    // A missing or malformed AUTH_SECRET must not hand out access.
    valid = false
  }

  if (!valid) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    const from = request.nextUrl.pathname + request.nextUrl.search
    if (from && from !== '/') url.searchParams.set('from', from)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Everything except: the login page and its action, the cron endpoint
     * (which authenticates with CRON_SECRET instead of a cookie), Next's own
     * assets, and static files.
     */
    '/((?!login|api/cron|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
