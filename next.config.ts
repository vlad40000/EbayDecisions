import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Keep build output honest: fail the deploy on type errors rather than
  // shipping a broken page to production.
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
