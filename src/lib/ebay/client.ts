/**
 * eBay REST client: application-level OAuth plus a small fetch wrapper.
 *
 * Auth is the client-credentials grant, which yields an *application* token —
 * enough for the read-only Buy APIs this app uses, with no user consent flow.
 * Tokens last about two hours and are cached in module scope, so a warm
 * serverless instance reuses one rather than minting a token per part.
 */

export type EbayAdapterName = 'browse' | 'insights'

export type EbayConfig = {
  clientId: string
  clientSecret: string
  host: string
  tokenUrl: string
  marketplaceId: string
  adapter: 'auto' | EbayAdapterName
  browseScope: string
  insightsScope: string
  syncLimit: number
}

export class EbayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'EbayError'
  }
}

/** True when credentials are present. Everything else degrades to manual entry. */
export function isEbayConfigured(): boolean {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET)
}

export function getEbayConfig(): EbayConfig {
  const clientId = process.env.EBAY_CLIENT_ID
  const clientSecret = process.env.EBAY_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new EbayError(
      'eBay is not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET, or keep entering market data by hand.',
    )
  }

  const sandbox = (process.env.EBAY_ENV ?? 'production').toLowerCase() === 'sandbox'
  const host = sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'

  const adapterRaw = (process.env.EBAY_ADAPTER ?? 'auto').toLowerCase()
  const adapter: EbayConfig['adapter'] =
    adapterRaw === 'browse' || adapterRaw === 'insights' ? adapterRaw : 'auto'

  const syncLimit = Number(process.env.EBAY_SYNC_LIMIT ?? '100')

  return {
    clientId,
    clientSecret,
    host,
    tokenUrl: `${host}/identity/v1/oauth2/token`,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
    adapter,
    browseScope: process.env.EBAY_SCOPE_BROWSE ?? 'https://api.ebay.com/oauth/api_scope',
    insightsScope:
      process.env.EBAY_SCOPE_INSIGHTS ??
      'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights',
    syncLimit: Number.isFinite(syncLimit) && syncLimit > 0 ? Math.floor(syncLimit) : 100,
  }
}

type CachedToken = { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 60_000

export async function getAccessToken(scope: string, config = getEbayConfig()): Promise<string> {
  const cached = tokenCache.get(scope)
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) return cached.token

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    cache: 'no-store',
  })

  const text = await response.text()

  if (!response.ok) {
    // A scope the app has not been granted fails here, not at the data call —
    // which is why the message names the scope.
    throw new EbayError(
      `eBay token request failed for scope "${scope}" (HTTP ${response.status}). If this is the Marketplace Insights scope, your app may not be approved for it yet.`,
      response.status,
      text.slice(0, 500),
    )
  }

  let parsed: { access_token?: string; expires_in?: number }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new EbayError('eBay returned a token response that was not JSON.', response.status, text.slice(0, 500))
  }

  if (!parsed.access_token) {
    throw new EbayError('eBay token response contained no access_token.', response.status, text.slice(0, 500))
  }

  const ttlMs = (parsed.expires_in ?? 7200) * 1000
  tokenCache.set(scope, { token: parsed.access_token, expiresAt: Date.now() + ttlMs })

  return parsed.access_token
}

/** GET against an eBay Buy API, with the marketplace header attached. */
export async function ebayGet<T>(
  path: string,
  params: Record<string, string>,
  scope: string,
  config = getEbayConfig(),
): Promise<T> {
  const token = await getAccessToken(scope, config)
  const url = new URL(`${config.host}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': config.marketplaceId,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })

  const text = await response.text()

  if (!response.ok) {
    throw new EbayError(
      `eBay ${path} failed (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 500),
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new EbayError(`eBay ${path} returned a non-JSON body.`, response.status, text.slice(0, 500))
  }
}

/** eBay's date-range filters want ISO-8601 UTC. */
export function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '.000Z')
}

export function daysAgo(days: number, from = new Date()): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000)
}
