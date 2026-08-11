/**
 * Minimal IndexedDB wrapper for the web-runtime:
 *   - recovery copies (crash recovery for docs)
 *   - attachment bytes (chat attachments picked via FSAccess; the renderer
 *     references them by an opaque id since browsers have no absolute paths)
 *
 * Single DB 'genoffice-web-runtime' with two object stores. Version 1.
 */

const DB_NAME = 'genoffice-web-runtime'
const DB_VERSION = 1
const STORE_RECOVERY = 'recovery'
const STORE_ATTACHMENTS = 'attachments'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_RECOVERY)) db.createObjectStore(STORE_RECOVERY)
      if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

function put(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const r = tx(db, store, 'readwrite').put(value, key)
        r.onsuccess = () => resolve()
        r.onerror = () => reject(r.error)
      }),
  )
}

function get<T>(store: string, key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const r = tx(db, store, 'readonly').get(key)
        r.onsuccess = () => resolve(r.result as T | undefined)
        r.onerror = () => reject(r.error)
      }),
  )
}

export interface RecoveryEntry {
  data: ArrayBuffer
  savedAt: number
}

export const recoveryStore = {
  put(key: string, data: ArrayBuffer): Promise<void> {
    return put(STORE_RECOVERY, key, { data, savedAt: Date.now() })
  },
  get(key: string): Promise<RecoveryEntry | undefined> {
    return get<RecoveryEntry>(STORE_RECOVERY, key)
  },
}

export interface AttachmentBytes {
  bytes: ArrayBuffer
  name: string
  ext: string
  mime: string
}

export const attachmentStore = {
  put(key: string, att: AttachmentBytes): Promise<void> {
    return put(STORE_ATTACHMENTS, key, att)
  },
  get(key: string): Promise<AttachmentBytes | undefined> {
    return get<AttachmentBytes>(STORE_ATTACHMENTS, key)
  },
}

/** Random ID for recovery entries / attachment keys. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
