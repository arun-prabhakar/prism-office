/**
 * Server runtime config. Secrets come from env (the Docker container reads
 * these at startup; missing/empty values fail-fast in `assertConfig`).
 *
 * Default dev values are intentionally permissive — Phase 1's end-to-end
 * test boots with them.
 */

export interface ServerConfig {
  port: number
  /** HS256 secret validating iframe configs (browser → editor service). */
  browserSecret: string
  /** HS256 secret signing editor-service → host requests (callbacks, file GETs). */
  outboxSecret: string
  /** Optional: HS256 secret validating host → editor-service requests (no /command yet in v1). */
  inboxSecret?: string
  /** TTL for /saved/<id> temp URLs (seconds). */
  savedUrlTtlSec: number
  /** Optional: operator's Genspark key for /ai/* proxy (Phase 4). */
  gskKey?: string
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? '3000'),
    browserSecret: required('GENOFFICE_BROWSER_SECRET', 'dev-browser-secret'),
    outboxSecret: required('GENOFFICE_OUTBOX_SECRET', 'dev-outbox-secret'),
    inboxSecret: process.env.GENOFFICE_INBOX_SECRET,
    savedUrlTtlSec: Number(process.env.SAVED_URL_TTL_SEC ?? '60'),
    gskKey: process.env.GENOFFICE_GSK_KEY,
  }
}
