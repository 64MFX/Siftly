import prisma from '@/lib/db'

export type AIProvider = 'anthropic' | 'openai' | 'minimax' | 'proxy'

export const AI_PROVIDERS: readonly AIProvider[] = ['anthropic', 'openai', 'minimax', 'proxy']

export function parseProvider(value: string | null | undefined): AIProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value ?? '') ? (value as AIProvider) : 'anthropic'
}

/**
 * The Setting key that stores the API key for a provider.
 */
export function apiKeySettingFor(provider: AIProvider): string {
  switch (provider) {
    case 'openai': return 'openaiApiKey'
    case 'minimax': return 'minimaxApiKey'
    case 'proxy': return 'proxyApiKey'
    default: return 'anthropicApiKey'
  }
}

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null
let _modelCacheExpiry = 0

let _cachedProvider: AIProvider | null = null
let _providerCacheExpiry = 0

let _cachedOpenAIModel: string | null = null
let _openAIModelCacheExpiry = 0

let _cachedMiniMaxModel: string | null = null
let _miniMaxModelCacheExpiry = 0

let _cachedProxyModel: string | null = null
let _proxyModelCacheExpiry = 0

const CACHE_TTL = 5 * 60 * 1000

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(): Promise<string> {
  if (_cachedModel && Date.now() < _modelCacheExpiry) return _cachedModel
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicModel' } })
  _cachedModel = setting?.value ?? 'claude-haiku-4-5-20251001'
  _modelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedModel
}

/**
 * Get the active AI provider (cached for 5 minutes).
 */
export async function getProvider(): Promise<AIProvider> {
  if (_cachedProvider && Date.now() < _providerCacheExpiry) return _cachedProvider
  const setting = await prisma.setting.findUnique({ where: { key: 'aiProvider' } })
  _cachedProvider = parseProvider(setting?.value)
  _providerCacheExpiry = Date.now() + CACHE_TTL
  return _cachedProvider
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedOpenAIModel = setting?.value ?? 'gpt-4.1-mini'
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedOpenAIModel
}

/**
 * Get the configured MiniMax model from settings (cached for 5 minutes).
 */
export async function getMiniMaxModel(): Promise<string> {
  if (_cachedMiniMaxModel && Date.now() < _miniMaxModelCacheExpiry) return _cachedMiniMaxModel
  const setting = await prisma.setting.findUnique({ where: { key: 'minimaxModel' } })
  _cachedMiniMaxModel = setting?.value ?? 'MiniMax-M2.7'
  _miniMaxModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedMiniMaxModel
}

/**
 * Get the model selected for the local proxy (cached for 5 minutes).
 * Empty string when none has been chosen yet — models are discovered from the proxy.
 */
export async function getProxyModel(): Promise<string> {
  if (_cachedProxyModel !== null && Date.now() < _proxyModelCacheExpiry) return _cachedProxyModel
  const setting = await prisma.setting.findUnique({ where: { key: 'proxyModel' } })
  _cachedProxyModel = setting?.value ?? ''
  _proxyModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedProxyModel
}

/**
 * Get the saved local proxy base URL, or undefined to fall back to env/default.
 */
export async function getProxyBaseUrl(): Promise<string | undefined> {
  const setting = await prisma.setting.findUnique({ where: { key: 'proxyBaseUrl' } })
  return setting?.value?.trim() || undefined
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(): Promise<string> {
  const provider = await getProvider()
  if (provider === 'proxy') return getProxyModel()
  if (provider === 'minimax') return getMiniMaxModel()
  return provider === 'openai' ? getOpenAIModel() : getAnthropicModel()
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedModel = null
  _modelCacheExpiry = 0
  _cachedProvider = null
  _providerCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
  _cachedMiniMaxModel = null
  _miniMaxModelCacheExpiry = 0
  _cachedProxyModel = null
  _proxyModelCacheExpiry = 0
}
