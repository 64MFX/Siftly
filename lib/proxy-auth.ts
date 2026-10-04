import OpenAI from 'openai'

/**
 * Local OpenAI-compatible proxy support (e.g. CLIProxyAPI / EasyCLIProxyAPI).
 *
 * CLIProxyAPI listens on http://127.0.0.1:8317 by default and exposes
 * OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints.
 * Clients authenticate with `Authorization: Bearer <key>`, where the key is
 * one of the `api-keys` configured in the proxy.
 */
export const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:8317/v1'

/**
 * Normalize a user-supplied proxy URL into an OpenAI SDK base URL.
 * - trims whitespace and trailing slashes
 * - strips a pasted `/chat/completions` or `/models` suffix
 * - appends `/v1` when no path is given (e.g. `http://localhost:8317`)
 *
 * Throws if the URL is not a valid http(s) URL.
 */
export function normalizeProxyBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://')
  }

  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(chat\/completions|models)$/, '')
  if (path === '') path = '/v1'

  return `${url.origin}${path}`
}

/**
 * Resolve an OpenAI-compatible client pointed at the local proxy.
 *
 * Base URL priority: explicit option → AI_PROXY_BASE_URL env → default.
 * Key priority: override key → DB key → AI_PROXY_API_KEY env → placeholder
 * (proxies without `api-keys` configured accept any bearer token).
 */
export function resolveProxyClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): OpenAI {
  const baseURL = normalizeProxyBaseUrl(
    options.baseURL?.trim() || process.env.AI_PROXY_BASE_URL?.trim() || DEFAULT_PROXY_BASE_URL,
  )

  const apiKey =
    options.overrideKey?.trim() ||
    options.dbKey?.trim() ||
    process.env.AI_PROXY_API_KEY?.trim() ||
    'no-key'

  return new OpenAI({ apiKey, baseURL })
}

export interface ProxyModel {
  id: string
  ownedBy?: string
}

/**
 * Fetch the models the proxy exposes via `GET {baseURL}/models`.
 * Returns model IDs sorted alphabetically.
 */
export async function listProxyModels(client: OpenAI): Promise<ProxyModel[]> {
  const models: ProxyModel[] = []
  for await (const m of client.models.list()) {
    if (!m?.id) continue
    models.push({ id: m.id, ownedBy: m.owned_by || undefined })
  }
  const seen = new Set<string>()
  return models
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id))
}
