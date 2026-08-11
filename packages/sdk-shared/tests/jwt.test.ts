import { describe, expect, it } from 'vitest'
import { signJwt, verifyJwt } from '../src/jwt'

describe('jwt (HS256 via Web Crypto)', () => {
  it('signs and verifies a payload round-trip', async () => {
    const payload = { documentType: 'word', document: { key: 'k1', url: 'u' } }
    const token = await signJwt(payload, 'secret')
    expect(token.split('.')).toHaveLength(3)
    const verified = await verifyJwt(token, 'secret')
    expect(verified).toEqual(payload)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signJwt({ a: 1 }, 'secret-a')
    const verified = await verifyJwt(token, 'secret-b')
    expect(verified).toBeNull()
  })

  it('rejects a malformed token', async () => {
    expect(await verifyJwt('not.a.jwt', 'secret')).toBeNull()
    expect(await verifyJwt('xxxxx.yyyyy', 'secret')).toBeNull()
    expect(await verifyJwt('', 'secret')).toBeNull()
  })

  it('uses unpadded base64url in all three segments', async () => {
    const token = await signJwt({ x: 'a' }, 's')
    for (const part of token.split('.')) {
      expect(part).not.toMatch(/=+$/)
      expect(part).not.toMatch(/[+/]/)
    }
  })
})
