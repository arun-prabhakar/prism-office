/**
 * Wire protocol between the host page and the editor iframe.
 *
 * Two channels:
 *   - host → iframe: commands (`init` once, then `method` calls like downloadAs).
 *   - iframe → host: events (lifecycle, errors, request events like onRequestHistory).
 *
 * Both sides must verify `event.origin` against the expected counterpart
 * before processing any message. The SDK pins the iframe origin from its
 * own `<script>` src; the iframe is expected to read its own opener origin
 * from a signed init payload (we embed the host origin in the JWT, so the
 * iframe learns it without trusting an unsigned postMessage).
 */

import type { EditorConfigRoot, EditorEvents } from '@prismoffice/editor-contract'

export const PROTOCOL_VERSION = 1

/** host → iframe */
export type HostMessage =
  | { type: 'init'; protocol: typeof PROTOCOL_VERSION; config: EditorConfigRoot }
  | { type: 'method'; id: string; method: string; args: unknown[] }
  | { type: 'destroy' }

/** iframe → host */
export type IframeMessage =
  | { type: 'app-ready' }
  | { type: 'event'; name: keyof EditorEvents & string; data?: unknown }
  | { type: 'method-response'; id: string; result?: unknown; error?: string }

export function isHostMessage(m: unknown): m is HostMessage {
  if (typeof m !== 'object' || m === null) return false
  const t = (m as { type?: unknown }).type
  return t === 'init' || t === 'method' || t === 'destroy'
}

export function isIframeMessage(m: unknown): m is IframeMessage {
  if (typeof m !== 'object' || m === null) return false
  const t = (m as { type?: unknown }).type
  return t === 'app-ready' || t === 'event' || t === 'method-response'
}
