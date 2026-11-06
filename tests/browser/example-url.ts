/**
 * Base URL of an example server. The root Playwright suite starts every
 * example on its documented port; a local configuration can point a spec at
 * another port with `NV_E2E_<NAME>_URL` (for example
 * `NV_E2E_LIVE_CRUD_URL=http://127.0.0.1:3381`).
 */
export function exampleUrl(name: string, port: number): string {
  const key = `NV_E2E_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
  return process.env[key] ?? `http://127.0.0.1:${port}`;
}
