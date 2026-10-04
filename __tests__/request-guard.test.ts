import { describe, it, expect } from 'vitest'
import { isCrossSiteRequest, isLocalRequest } from '@/lib/request-guard'

const req = (headers: Record<string, string>) => new Request('http://localhost:28417/api/x-account', { method: 'POST', headers })

describe('isCrossSiteRequest', () => {
  it("allows Siftly's own pages, curl and the CLI", () => {
    expect(isCrossSiteRequest(req({ host: 'localhost:28417', origin: 'http://localhost:28417', 'sec-fetch-site': 'same-origin' }))).toBe(false)
    expect(isCrossSiteRequest(req({ host: 'localhost:28417' }))).toBe(false)
  })

  it('refuses other websites, other local apps and opaque origins', () => {
    expect(isCrossSiteRequest(req({ host: 'localhost:28417', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).toBe(true)
    expect(isCrossSiteRequest(req({ host: 'localhost:28417', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }))).toBe(true)
    expect(isCrossSiteRequest(req({ host: 'localhost:28417', origin: 'http://localhost:3000' }))).toBe(true)
    expect(isCrossSiteRequest(req({ host: 'localhost:28417', origin: 'null' }))).toBe(true)
  })
})

describe('isLocalRequest', () => {
  it('recognises loopback hosts', () => {
    for (const host of ['localhost:28417', '127.0.0.1:28417', '[::1]:28417', 'siftly.localhost']) {
      expect(isLocalRequest(req({ host }))).toBe(true)
    }
    expect(isLocalRequest(req({ host: '192.168.1.20:28417' }))).toBe(false)
  })
})
