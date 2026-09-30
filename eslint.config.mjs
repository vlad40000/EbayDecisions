import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

/** Flat config — eslint-config-next 16 ships native flat configs, no compat shim. */
const config = [
  { ignores: ['.next/**', 'node_modules/**', 'drizzle/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
]

export default config
