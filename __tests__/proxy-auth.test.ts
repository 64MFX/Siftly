import { describe, it, expect, vi, afterEach } from 'vitest'
import type OpenAI from 'openai'
import { normalizeProxyBaseUrl, resolveProxyClient, listProxyModels, DEFAULT_PROXY_BASE_URL } from '@/lib/proxy-auth'
import { ProxyAIClient } from '@/lib/ai-client'

describe('normalizeProxyBaseUrl', () => {
  it('appends /v1 when no path is given', () => {
    expect(normalizeProxyBaseUrl('http://localhost:8317')).toBe('http://localhost:8317/v1')
    expect(normalizeProxyBaseUrl('http://localhost:8317/')).toBe('http://localhost:8317/v1')
  })

  it('keeps an explicit path and strips trailing slashes', () => {
    expect(normalizeProxyBaseUrl(' http://127.0.0.1:8317/v1/ ')).toBe('http://127.0.0.1:8317/v1')
    expect(normalizeProxyBaseUrl('https://proxy.local/openai/v1')).toBe('https://proxy.local/openai/v1')
  })

  it('strips pasted endpoint suffixes', () => {
    expect(normalizeProxyBaseUrl('http://localhost:8317/v1/chat/completions')).toBe('http://localhost:8317/v1')
    expect(normalizeProxyBaseUrl('http://localhost:8317/v1/models')).toBe('http://localhost:8317/v1')
  })

  it('rejects invalid or non-http URLs', () => {
    expect(() => normalizeProxyBaseUrl('not a url')).toThrow()
    expect(() => normalizeProxyBaseUrl('ftp://localhost:8317')).toThrow()
  })
})

describe('resolveProxyClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the default CLIProxyAPI URL', () => {
    vi.stubEnv('AI_PROXY_BASE_URL', '')
    vi.stubEnv('AI_PROXY_API_KEY', '')
    const client = resolveProxyClient()
    expect(client.baseURL).toBe(DEFAULT_PROXY_BASE_URL)
  })

  it('prefers override key over DB key over env key', () => {
    vi.stubEnv('AI_PROXY_API_KEY', 'env-key')
    expect(resolveProxyClient({ overrideKey: 'over', dbKey: 'db' }).apiKey).toBe('over')
    expect(resolveProxyClient({ dbKey: 'db' }).apiKey).toBe('db')
    expect(resolveProxyClient({}).apiKey).toBe('env-key')
  })

  it('uses the saved base URL', () => {
    const client = resolveProxyClient({ baseURL: 'http://192.168.1.5:9000' })
    expect(client.baseURL).toBe('http://192.168.1.5:9000/v1')
  })
})

describe('listProxyModels', () => {
  it('returns unique model IDs sorted alphabetically', async () => {
    const page = [
      { id: 'gpt-5', owned_by: 'openai' },
      { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
      { id: 'gpt-5', owned_by: 'openai' },
      { id: 'gemini-2.5-pro', owned_by: '' },
    ]
    const client = {
      models: {
        list: () => ({
          async *[Symbol.asyncIterator]() { yield* page },
        }),
      },
    } as unknown as OpenAI

    const models = await listProxyModels(client)
    expect(models).toEqual([
      { id: 'claude-sonnet-4-5', ownedBy: 'anthropic' },
      { id: 'gemini-2.5-pro', ownedBy: undefined },
      { id: 'gpt-5', ownedBy: 'openai' },
    ])
  })
})

describe('ProxyAIClient', () => {
  function mockSdk(content: string) {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] })
    return { sdk: { chat: { completions: { create } } } as unknown as OpenAI, create }
  }

  it('has provider set to proxy', () => {
    expect(new ProxyAIClient(mockSdk('').sdk).provider).toBe('proxy')
  })

  it('sends the selected model and strips thinking tags', async () => {
    const { sdk, create } = mockSdk('<think>hmm</think>\nAnswer')
    const client = new ProxyAIClient(sdk)
    const result = await client.createMessage({
      model: 'gemini-2.5-pro',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.text).toBe('Answer')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-pro' }))
  })

  it('throws a clear error when no model is selected', async () => {
    const client = new ProxyAIClient(mockSdk('x').sdk)
    await expect(client.createMessage({ model: '', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/No model selected/)
  })
})
