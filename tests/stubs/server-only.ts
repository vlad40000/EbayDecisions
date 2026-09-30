/**
 * Stub for the `server-only` package under Vitest.
 *
 * The real package exports a module that throws unless resolved through the
 * `react-server` condition, which Next sets during a build and Vitest does not.
 * The guard is a build-time check; the tests are server code, so this empty
 * module lets them import the same files Next protects.
 */
export {}
