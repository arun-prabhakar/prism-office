/**
 * Host-side JWT helper for signing an editor config.
 *
 * Integrators on Node can use any JWT library they like (jsonwebtoken, jose,
 * etc.) — this is the dependency-free option using Web Crypto, mirrored from
 * `./jwt.ts`. Browser integrators can use this directly.
 */

import type { EditorConfigRoot, EditorConfigTokenPayload } from '@prismoffice/editor-contract'
import { signJwt, verifyJwt } from './jwt'

/**
 * Sign the serializable subset of an editor config with HS256.
 *
 * Functions (the `events` callbacks) are not serializable — they are dropped
 * before signing. The iframe re-validates this subset on init.
 */
export async function signConfig(
  config: EditorConfigRoot,
  secret: string,
): Promise<string> {
  const payload: EditorConfigTokenPayload = {
    document: config.document,
    editorConfig: config.editorConfig,
    documentType: config.documentType,
    type: config.type,
  }
  return signJwt(payload, secret)
}

/**
 * Verify a config token and return the parsed payload, or null.
 * Used by the editor iframe on init.
 */
export async function verifyConfigToken(
  token: string,
  secret: string,
): Promise<EditorConfigTokenPayload | null> {
  return verifyJwt<EditorConfigTokenPayload>(token, secret)
}
