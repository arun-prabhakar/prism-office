/**
 * In-memory temp URL store. Holds doc bytes the iframe POSTs to
 * /save-document; the host fetches them via GET /saved/<id>.
 *
 * Entries expire after `ttlSec` (default 60s). A sweep timer cleans expired
 * entries every 30s so memory doesn't accumulate under sustained load.
 *
 * Stateless / horizontally-scalable deployments would swap this for Redis —
 * the API surface here is the contract.
 */

export interface SavedEntry {
  bytes: Uint8Array
  filetype: string
  key: string
  expiresAt: number
}

export class TempStore {
  private readonly entries = new Map<string, SavedEntry>()
  private readonly sweep: NodeJS.Timeout

  constructor(private readonly ttlSec: number) {
    this.sweep = setInterval(() => this.sweepExpired(), 30_000)
    this.sweep.unref?.()
  }

  put(id: string, entry: Omit<SavedEntry, 'expiresAt'>): void {
    this.entries.set(id, { ...entry, expiresAt: Date.now() + this.ttlSec * 1000 })
  }

  get(id: string): SavedEntry | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id)
      return undefined
    }
    return entry
  }

  delete(id: string): void {
    this.entries.delete(id)
  }

  close(): void {
    clearInterval(this.sweep)
    this.entries.clear()
  }

  private sweepExpired(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(id)
    }
  }
}

/** Random URL-safe ID for /saved/<id>. */
export function newSavedId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
