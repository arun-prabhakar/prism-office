import { beforeEach, describe, expect, it } from 'vitest'
import { signConfig, verifyConfigToken } from '../src/jwt-sign-browser'

describe('signConfig / verifyConfigToken', () => {
  it('round-trips a serializable config subset (drops events functions)', async () => {
    const config = {
      documentType: 'word' as const,
      document: {
        key: 'Khirz6zTPdfd7',
        url: 'https://host/files/abc.docx',
        fileType: 'docx',
        title: 'Example.docx',
      },
      editorConfig: {
        mode: 'edit' as const,
        callbackUrl: 'https://host/track',
        user: { id: 'u1', name: 'Alice' },
      },
      events: {
        onDocumentReady: () => {
          /* should be dropped — functions aren't serializable */
        },
      },
    }
    const token = await signConfig(config, 'browser-secret')
    const payload = await verifyConfigToken(token, 'browser-secret')

    expect(payload).not.toBeNull()
    expect(payload?.documentType).toBe('word')
    expect(payload?.document.key).toBe('Khirz6zTPdfd7')
    expect(payload?.editorConfig?.user?.id).toBe('u1')
    // No `events` in the signed payload (functions were dropped).
    expect((payload as unknown as { events?: unknown }).events).toBeUndefined()
  })

  it('rejects a token signed with the wrong secret', async () => {
    const config = {
      documentType: 'pdf' as const,
      document: { key: 'k', url: 'u', fileType: 'pdf' },
    }
    const token = await signConfig(config, 'wrong')
    expect(await verifyConfigToken(token, 'right')).toBeNull()
  })
})
