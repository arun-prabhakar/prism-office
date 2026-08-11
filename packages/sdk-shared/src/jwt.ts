/**
 * JWT (HS256) sign / verify using Web Crypto API.
 *
 * Works in the browser (iframe host page) and in Node 20+ (which ships global
 * `crypto.subtle`, `btoa`, `atob`). Asynchronous because SubtleCrypto is async.
 *
 * This is intentionally a small, dependency-free implementation. For
 * production integrators who already have a JWT library, the SDK exports
 * `signConfig` / `verifyConfigToken` as thin wrappers — pass in your own
 * token if you prefer.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

function base64UrlEncode(bytes: Uint8Array): string {
  // Convert Uint8Array → base64 → base64url (no padding).
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export interface JwtHeader {
  alg: 'HS256'
  typ: 'JWT'
}

/**
 * Sign an arbitrary JSON-serializable payload with HS256.
 * Returns `header.payload.signature` (all base64url, no padding).
 */
export async function signJwt(payload: unknown, secret: string): Promise<string> {
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`
  const key = await hmacKey(secret)
  const sigBuf = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signingInput)))
  return `${signingInput}.${base64UrlEncode(sigBuf)}`
}

/**
 * Copy a Uint8Array into a fresh ArrayBuffer. Required because TS 5.7+'s
 * generic Uint8Array<ArrayBufferLike> can carry a SharedArrayBuffer, which
 * SubtleCrypto.verify rejects. The copy guarantees an ArrayBuffer-backed view.
 */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(u.byteLength)
  new Uint8Array(copy).set(u)
  return copy
}

/** Verified JWT payload, or null if signature/header is invalid. */
export async function verifyJwt<T = unknown>(token: string, secret: string): Promise<T | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  const signingInput = `${headerB64}.${payloadB64}`

  try {
    const key = await hmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      toArrayBuffer(base64UrlDecode(sigB64)),
      toArrayBuffer(enc.encode(signingInput)),
    )
    if (!valid) return null

    const header = JSON.parse(dec.decode(base64UrlDecode(headerB64))) as JwtHeader
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null

    return JSON.parse(dec.decode(base64UrlDecode(payloadB64))) as T
  } catch {
    return null
  }
}
