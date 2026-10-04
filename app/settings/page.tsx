'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Eye,
  EyeOff,
  Download,
  Check,
  AlertCircle,
  Key,
  Database,
  Info,
  Trash2,
  Shield,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Zap,
  Copy,
  Coffee,
  Terminal,
  Loader2,
  X,
  BookOpen,
  Folder,
  FolderOpen,
  RefreshCw,
  Server,
  HardDrive,
  HardDriveDownload,
  Square,
  Cloud,
  CornerLeftUp,
  LogIn,
  LogOut,
} from 'lucide-react'

type AIProvider = 'anthropic' | 'openai' | 'minimax' | 'proxy'

const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  minimax: 'MiniMax',
  proxy: 'Local Proxy',
}

const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:8317/v1'

const ANTHROPIC_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fast & Cheap' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Smart & Balanced' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Most Capable' },
]

const OPENAI_MODELS = [
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Fast & Cheap' },
  { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Most Capable' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', description: 'Fastest' },
  { value: 'o4-mini', label: 'o4-mini', description: 'Reasoning (mini)' },
  { value: 'o3', label: 'o3', description: 'Reasoning' },
]

const MINIMAX_MODELS = [
  { value: 'MiniMax-M2.7', label: 'M2.7', description: '1M Context, Latest' },
  { value: 'MiniMax-M2.5', label: 'M2.5', description: '204K Context' },
  { value: 'MiniMax-M2.5-highspeed', label: 'M2.5 Highspeed', description: '204K, Fastest' },
]


interface Toast {
  type: 'success' | 'error'
  message: string
}

function ToastAlert({ toast }: { toast: Toast }) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium border ${
        toast.type === 'success'
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
          : 'bg-red-500/10 text-red-400 border-red-500/20'
      }`}
    >
      {toast.type === 'success' ? <Check size={15} className="shrink-0" /> : <AlertCircle size={15} className="shrink-0" />}
      {toast.message}
    </div>
  )
}

interface SectionProps {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  description: string
  children: React.ReactNode
  variant?: 'default' | 'danger'
}

function Section({ icon: Icon, title, description, children, variant = 'default' }: SectionProps) {
  const isDanger = variant === 'danger'
  return (
    <div
      className={`bg-zinc-900 rounded-2xl p-6 transition-all duration-200 ${
        isDanger
          ? 'border border-red-700/60 hover:border-red-600/70'
          : 'border border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start gap-3 mb-5">
        <div
          className={`p-2.5 rounded-xl shrink-0 ${
            isDanger ? 'bg-red-800/40' : 'bg-indigo-500/10'
          }`}
        >
          <Icon size={16} className={isDanger ? 'text-red-500' : 'text-indigo-400'} />
        </div>
        <div>
          <h2 className={`text-base font-semibold ${isDanger ? 'text-red-400' : 'text-zinc-100'}`}>
            {title}
          </h2>
          <p className="text-sm text-zinc-500 mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function ApiKeyField({
  label,
  placeholder,
  fieldKey,
  hint,
  docHref,
  docLabel = 'Get key',
  onToast,
  onChanged,
  testProvider,
}: {
  label: string
  placeholder: string
  fieldKey: 'anthropicApiKey' | 'openaiApiKey' | 'minimaxApiKey' | 'proxyApiKey'
  hint: string
  docHref: string
  docLabel?: string
  onToast: (t: Toast) => void
  onChanged?: () => void
  testProvider?: string
}) {
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [savedMasked, setSavedMasked] = useState<string | null>(null)
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testError, setTestError] = useState('')

  // Load existing saved key status on mount
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        const hasKeyField = {
          anthropicApiKey: 'hasAnthropicKey',
          openaiApiKey: 'hasOpenaiKey',
          minimaxApiKey: 'hasMinimaxKey',
          proxyApiKey: 'hasProxyKey',
        }[fieldKey]
        const hasKey = d[hasKeyField]
        const masked = d[fieldKey] as string | null
        if (hasKey && masked) setSavedMasked(masked)
      })
      .catch(() => {})
  }, [fieldKey])

  async function handleSave() {
    if (!key.trim()) {
      onToast({ type: 'error', message: 'Please enter an API key' })
      return
    }
    setSaving(true)
    setTestState('idle')
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldKey]: key.trim() }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? 'Failed to save')
      }
      setSavedMasked(key.trim().slice(0, 6) + '••••••••' + key.trim().slice(-4))
      setKey('')
      onChanged?.()
      // Auto-test after save
      if (testProvider) void handleTest()
      else onToast({ type: 'success', message: `${label} saved successfully` })
    } catch (err) {
      onToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save API key',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: fieldKey }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? 'Failed to remove')
      }
      setSavedMasked(null)
      setTestState('idle')
      onChanged?.()
      onToast({ type: 'success', message: `${label} removed` })
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to remove key' })
    } finally {
      setRemoving(false)
    }
  }

  async function handleTest() {
    if (!testProvider) return
    setTestState('testing')
    setTestError('')
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: testProvider }),
      })
      const data = await res.json() as { working: boolean; error?: string }
      if (data.working) {
        setTestState('ok')
        onToast({ type: 'success', message: `${label} is working` })
      } else {
        setTestState('fail')
        setTestError(data.error ?? 'Key test failed')
      }
    } catch {
      setTestState('fail')
      setTestError('Connection error')
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <p className="text-sm font-medium text-zinc-300 shrink-0">{label}</p>
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          {savedMasked && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-lg min-w-0 overflow-hidden">
              <Check size={11} className="shrink-0" /> <span className="shrink-0">Saved:</span> <span className="font-mono truncate">{savedMasked}</span>
            </span>
          )}
          {savedMasked && (
            <button
              onClick={() => void handleRemove()}
              disabled={removing}
              className="shrink-0 text-xs text-red-500/70 hover:text-red-400 transition-colors disabled:opacity-50"
              title="Remove saved key"
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          )}
          {testProvider && savedMasked && testState === 'idle' && (
            <button
              onClick={() => void handleTest()}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Test
            </button>
          )}
          {testState === 'testing' && (
            <span className="flex items-center gap-1 text-xs text-zinc-400 shrink-0">
              <Loader2 size={11} className="animate-spin" /> Testing…
            </span>
          )}
          {testState === 'ok' && (
            <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0">
              <Check size={11} /> Working
            </span>
          )}
          {testState === 'fail' && (
            <span className="flex items-center gap-1 text-xs text-red-400 shrink-0" title={testError}>
              <X size={11} /> {testError.slice(0, 30) || 'Failed'}
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-2.5">
        <div className="relative flex-1">
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
            placeholder={savedMasked ? 'Enter new key to replace…' : placeholder}
            className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all duration-200 pr-10 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shrink-0"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-600">{hint}</p>
        <a
          href={docHref}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-400 transition-colors"
        >
          {docLabel} <ExternalLink size={11} />
        </a>
      </div>
    </div>
  )
}

function ModelSelector({
  models,
  settingKey,
  defaultValue,
  onToast,
}: {
  models: { value: string; label: string; description: string }[]
  settingKey: 'anthropicModel' | 'openaiModel' | 'minimaxModel'
  defaultValue: string
  onToast: (t: Toast) => void
}) {
  const [value, setValue] = useState(defaultValue)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => { if (d[settingKey]) setValue(d[settingKey] as string) })
      .catch(() => {})
  }, [settingKey])

  async function handleChange(newVal: string) {
    setValue(newVal)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [settingKey]: newVal }),
      })
      if (!res.ok) throw new Error('Failed')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      onToast({ type: 'error', message: 'Failed to save model preference' })
    }
  }

  const selected = models.find((m) => m.value === value) ?? models[0]

  return (
    <>
      <div className="flex items-center gap-2 mt-2.5">
        <span className="text-xs text-zinc-500 shrink-0">Model:</span>
        <div className="relative flex-1">
          <select
            value={value}
            onChange={(e) => void handleChange(e.target.value)}
            className="w-full appearance-none pl-3 pr-8 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label} — {m.description}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
        </div>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0">
            <Check size={12} /> Saved
          </span>
        )}
        {!saved && selected && (
          <span className="text-xs text-zinc-600 shrink-0 hidden sm:block">{selected.description}</span>
        )}
      </div>
      {value === 'claude-opus-4-6' && (
        <p className="text-xs text-amber-500/80 mt-1.5">
          Opus is slow with 20 parallel workers — consider Sonnet or Haiku for faster bulk categorization.
        </p>
      )}
    </>
  )
}

interface CliStatus {
  available: boolean
  subscriptionType?: string
  expired?: boolean
}

function ClaudeCliStatusBox() {
  const [status, setStatus] = useState<CliStatus | null>(null)

  useEffect(() => {
    fetch('/api/settings/cli-status')
      .then((r) => r.json())
      .then((d: CliStatus) => setStatus(d))
      .catch(() => setStatus({ available: false }))
  }, [])

  if (status === null) return null // loading — don't flash UI

  if (status.available && !status.expired) {
    const tier = status.subscriptionType
      ? status.subscriptionType.charAt(0).toUpperCase() + status.subscriptionType.slice(1)
      : 'CLI'
    return (
      <div className="flex gap-3 p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/20 mb-5">
        <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-emerald-300">
            Claude CLI detected — no API key needed
          </p>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            Signed in as <span className="text-zinc-300">{tier}</span> via Claude Code. Siftly will use your subscription automatically. An API key below will take priority if set.
          </p>
        </div>
      </div>
    )
  }

  if (status.available && status.expired) {
    return (
      <div className="flex gap-3 p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 mb-5">
        <AlertCircle size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-300">Claude CLI session expired</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Run <span className="font-mono text-zinc-300">claude</span> in your terminal to refresh the session, then reload this page.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3 p-3.5 rounded-xl bg-zinc-800/60 border border-zinc-700 mb-5">
      <Terminal size={15} className="text-zinc-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-200">No Claude CLI detected</p>
        <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
          Install Claude Code and sign in to skip the API key entirely, or paste your API key below.
        </p>
      </div>
    </div>
  )
}

function CodexCliStatusBox() {
  const [status, setStatus] = useState<{ available: boolean; expired?: boolean; planType?: string; authMode?: string; hasCredentials?: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/settings/cli-status')
      .then((r) => r.json())
      .then((d: { codex?: { available: boolean; expired?: boolean; planType?: string; authMode?: string; hasCredentials?: boolean } }) => setStatus(d.codex ?? { available: false }))
      .catch(() => setStatus({ available: false }))
  }, [])

  if (status === null) return null

  if (status.available && !status.expired) {
    const tier = status.planType
      ? status.planType.charAt(0).toUpperCase() + status.planType.slice(1)
      : 'CLI'
    const isChatGPT = status.authMode === 'chatgpt'
    return (
      <div className="flex gap-3 p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/20 mb-5">
        <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-emerald-300">
            Codex CLI detected{isChatGPT ? ' (ChatGPT login)' : ' — no API key needed'}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            {isChatGPT ? (
              <>Signed in as <span className="text-zinc-300">{tier}</span> via ChatGPT. AI features will use Codex CLI to proxy requests. An API key below will take priority if set.</>
            ) : (
              <>Signed in as <span className="text-zinc-300">{tier}</span> via Codex CLI. Siftly will use your credentials automatically. An API key below will take priority if set.</>
            )}
          </p>
        </div>
      </div>
    )
  }

  if (status.hasCredentials && status.expired) {
    return (
      <div className="flex gap-3 p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 mb-5">
        <AlertCircle size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-300">Codex CLI session expired</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Run <span className="font-mono text-zinc-300">codex</span> in your terminal to refresh, then reload this page.
          </p>
        </div>
      </div>
    )
  }

  if (status.hasCredentials && !status.available) {
    return (
      <div className="flex gap-3 p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 mb-5">
        <AlertCircle size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-300">Codex credentials found but CLI not available</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Found saved credentials but the <span className="font-mono text-zinc-300">codex</span> binary is not responding. Install or reinstall Codex CLI, or paste your OpenAI API key below.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3 p-3.5 rounded-xl bg-zinc-800/60 border border-zinc-700 mb-5">
      <Terminal size={15} className="text-zinc-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-200">No Codex CLI detected</p>
        <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
          Install Codex CLI and sign in to skip the API key entirely, or paste your OpenAI API key below.
        </p>
      </div>
    </div>
  )
}

function ProviderToggle({ value, onChange }: { value: AIProvider; onChange: (v: AIProvider) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-800 border border-zinc-700 mb-5">
      <button
        onClick={() => onChange('anthropic')}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          value === 'anthropic'
            ? 'bg-indigo-600 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        Anthropic
      </button>
      <button
        onClick={() => onChange('openai')}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          value === 'openai'
            ? 'bg-emerald-600 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        OpenAI
      </button>
      <button
        onClick={() => onChange('minimax')}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          value === 'minimax'
            ? 'bg-orange-600 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        MiniMax
      </button>
      <button
        onClick={() => onChange('proxy')}
        className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
          value === 'proxy'
            ? 'bg-sky-600 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        Local Proxy
      </button>
    </div>
  )
}

function ProxyUrlField({ onToast, onSaved }: { onToast: (t: Toast) => void; onSaved: () => void }) {
  const [url, setUrl] = useState('')
  const [savedUrl, setSavedUrl] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: { proxyBaseUrl?: string }) => {
        const value = d.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL
        setUrl(value)
        setSavedUrl(value)
      })
      .catch(() => setUrl(DEFAULT_PROXY_BASE_URL))
  }, [])

  async function handleSave() {
    if (!url.trim()) {
      onToast({ type: 'error', message: 'Please enter the proxy URL' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyBaseUrl: url.trim() }),
      })
      const data = await res.json() as { error?: string; proxyBaseUrl?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      const normalized = data.proxyBaseUrl ?? url.trim()
      setUrl(normalized)
      setSavedUrl(normalized)
      onToast({ type: 'success', message: 'Proxy URL saved' })
      onSaved()
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save proxy URL' })
    } finally {
      setSaving(false)
    }
  }

  const dirty = url.trim() !== savedUrl

  return (
    <div className="space-y-2.5">
      <p className="text-sm font-medium text-zinc-300">Proxy URL</p>
      <div className="flex gap-2.5">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
          placeholder={DEFAULT_PROXY_BASE_URL}
          className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all duration-200 font-mono"
        />
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shrink-0"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-zinc-600">
        OpenAI-compatible endpoint. CLIProxyAPI / EasyCLIProxyAPI defaults to <code className="font-mono">{DEFAULT_PROXY_BASE_URL}</code>.
      </p>
    </div>
  )
}

function ProxyModelSelector({ onToast, refreshKey }: { onToast: (t: Toast) => void; refreshKey: number }) {
  const [value, setValue] = useState('')
  const [models, setModels] = useState<{ id: string; ownedBy?: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: { proxyModel?: string }) => { if (d.proxyModel) setValue(d.proxyModel) })
      .catch(() => {})
  }, [])

  const loadModels = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/settings/proxy-models')
      const data = await res.json() as { models?: { id: string; ownedBy?: string }[]; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to fetch models')
      setModels(data.models ?? [])
      if ((data.models ?? []).length === 0) setError('Proxy returned no models')
    } catch (err) {
      setModels([])
      setError(err instanceof Error ? err.message : 'Failed to fetch models')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch on mount and whenever the URL or key changes
  useEffect(() => { void loadModels() }, [loadModels, refreshKey])

  async function handleChange(newVal: string) {
    const prev = value
    setValue(newVal)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyModel: newVal }),
      })
      if (!res.ok) throw new Error('Failed')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setValue(prev)
      onToast({ type: 'error', message: 'Failed to save model preference' })
    }
  }

  // Keep the saved model selectable even if the proxy no longer lists it
  const options = value && !models.some((m) => m.id === value)
    ? [{ id: value, ownedBy: undefined as string | undefined }, ...models]
    : models
  const selected = models.find((m) => m.id === value)

  return (
    <>
      <div className="flex items-center gap-2 mt-2.5">
        <span className="text-xs text-zinc-500 shrink-0">Model:</span>
        <div className="relative flex-1 min-w-0">
          <select
            value={value}
            onChange={(e) => void handleChange(e.target.value)}
            disabled={options.length === 0}
            className="w-full appearance-none pl-3 pr-8 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          >
            {!value && (
              <option value="" disabled>
                {loading ? 'Loading models…' : options.length === 0 ? 'No models — fetch from proxy' : 'Select a model…'}
              </option>
            )}
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}{m.ownedBy ? ` — ${m.ownedBy}` : ''}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
        </div>
        <button
          onClick={() => void loadModels()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-colors shrink-0 disabled:opacity-50"
          title="Fetch models from proxy"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Fetching…' : 'Fetch models'}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0">
            <Check size={12} /> Saved
          </span>
        )}
      </div>
      {error ? (
        <p className="text-xs text-red-400 mt-1.5">{error}</p>
      ) : !loading && models.length > 0 ? (
        <p className="text-xs text-zinc-500 mt-1.5">
          {models.length} model{models.length === 1 ? '' : 's'} available{selected?.ownedBy ? ` · ${value} via ${selected.ownedBy}` : ''}
        </p>
      ) : null}
    </>
  )
}

function ProxySettings({ onToast }: { onToast: (t: Toast) => void }) {
  // Bumped after the URL or key changes so the model list refetches
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  return (
    <>
      <div className="flex gap-3 p-3.5 rounded-xl bg-zinc-800/60 border border-zinc-700 mb-5">
        <Server size={15} className="text-sky-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200">Use a local OpenAI-compatible proxy</p>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            Works with CLIProxyAPI / EasyCLIProxyAPI and similar proxies. Enter the proxy URL and one of its configured API keys, then pick any model the proxy exposes.
          </p>
        </div>
      </div>
      <div className="space-y-5">
        <ProxyUrlField onToast={onToast} onSaved={refresh} />
        <div>
          <ApiKeyField
            label="Proxy API Key"
            placeholder="One of the api-keys in your proxy config"
            fieldKey="proxyApiKey"
            hint="Leave empty if your proxy doesn't require a key."
            docHref="https://github.com/router-for-me/CLIProxyAPI"
            docLabel="Proxy docs"
            onToast={onToast}
            onChanged={refresh}
            testProvider="proxy"
          />
          <ProxyModelSelector onToast={onToast} refreshKey={refreshKey} />
          <p className="text-xs text-zinc-500 mt-1.5">Applies to all AI operations. Image analysis needs a vision-capable model.</p>
        </div>
      </div>
    </>
  )
}

function ApiKeySection({ onToast }: { onToast: (t: Toast) => void }) {
  const [provider, setProvider] = useState<AIProvider | null>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: { provider?: string }) => {
        setProvider(d.provider && d.provider in PROVIDER_LABELS ? d.provider as AIProvider : 'anthropic')
      })
      .catch(() => setProvider('anthropic'))
  }, [])

  async function handleProviderChange(newProvider: AIProvider) {
    const prev = provider
    setProvider(newProvider)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: newProvider }),
      })
      if (!res.ok) throw new Error('Failed to save provider')
      onToast({ type: 'success', message: `Switched to ${PROVIDER_LABELS[newProvider]}` })
    } catch {
      setProvider(prev) // revert on failure
      onToast({ type: 'error', message: 'Failed to save provider preference' })
    }
  }

  // Don't render until we know the saved provider — avoids flicker
  if (provider === null) {
    return (
      <Section
        icon={Key}
        title="AI Provider"
        description="Choose your AI provider and configure keys. CLI auth means no key needed."
      >
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 size={14} className="animate-spin" /> Loading settings…
        </div>
      </Section>
    )
  }

  return (
    <Section
      icon={Key}
      title="AI Provider"
      description="Choose your AI provider and configure keys. CLI auth means no key needed."
    >
      <ProviderToggle value={provider} onChange={(v) => void handleProviderChange(v)} />

      {provider === 'anthropic' ? (
        <>
          <ClaudeCliStatusBox />
          <div className="space-y-5">
            <div>
              <ApiKeyField
                label="Anthropic (Claude)"
                placeholder="sk-ant-api03-..."
                fieldKey="anthropicApiKey"
                hint="Used for AI categorization, search, and image analysis."
                docHref="https://console.anthropic.com"
                onToast={onToast}
                testProvider="anthropic"
              />
              <ModelSelector
                models={ANTHROPIC_MODELS}
                settingKey="anthropicModel"
                defaultValue="claude-haiku-4-5-20251001"
                onToast={onToast}
              />
              <p className="text-xs text-zinc-500 mt-1.5">Applies to all AI operations — API key <strong className="text-zinc-400 font-medium">and Claude CLI</strong></p>
            </div>
          </div>
        </>
      ) : provider === 'openai' ? (
        <>
          <CodexCliStatusBox />
          <div className="space-y-5">
            <div>
              <ApiKeyField
                label="OpenAI"
                placeholder="sk-..."
                fieldKey="openaiApiKey"
                hint="Used for AI categorization, search, and image analysis."
                docHref="https://platform.openai.com/api-keys"
                onToast={onToast}
                testProvider="openai"
              />
              <ModelSelector
                models={OPENAI_MODELS}
                settingKey="openaiModel"
                defaultValue="gpt-4.1-mini"
                onToast={onToast}
              />
              <p className="text-xs text-zinc-500 mt-1.5">Applies to all AI operations — API key <strong className="text-zinc-400 font-medium">and Codex CLI</strong></p>
            </div>
          </div>
        </>
      ) : provider === 'proxy' ? (
        <ProxySettings onToast={onToast} />
      ) : (
        <div className="space-y-5">
          <div>
            <ApiKeyField
              label="MiniMax"
              placeholder="eyJ..."
              fieldKey="minimaxApiKey"
              hint="Used for AI categorization, search, and image analysis."
              docHref="https://platform.minimaxi.com/user-center/basic-information/interface-key"
              onToast={onToast}
              testProvider="minimax"
            />
            <ModelSelector
              models={MINIMAX_MODELS}
              settingKey="minimaxModel"
              defaultValue="MiniMax-M2.7"
              onToast={onToast}
            />
            <p className="text-xs text-zinc-500 mt-1.5">MiniMax M2.7 supports 1M context window — great for large batch categorization</p>
          </div>
        </div>
      )}
      <p className="text-xs text-zinc-600 mt-4">Keys are stored in plaintext in your local SQLite database (<code className="font-mono">prisma/dev.db</code>). Do not expose the database file.</p>
    </Section>
  )
}

function ExportButton({
  label,
  href,
  description,
}: {
  label: string
  href: string
  description: string
}) {
  return (
    <button
      onClick={() => {
        window.location.href = href
      }}
      className="flex flex-col items-start gap-1 p-4 rounded-xl bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 hover:border-zinc-600 transition-all duration-200 text-left group w-full"
    >
      <div className="flex items-center gap-2">
        <Download size={14} className="text-zinc-400 group-hover:text-zinc-200 transition-colors" />
        <span className="text-sm font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">
          {label}
        </span>
      </div>
      <p className="text-xs text-zinc-600">{description}</p>
    </button>
  )
}

interface ObsidianResult {
  written: number
  skipped: number
  errors: Array<{ tweetId: string; error: string }>
  indexesWritten: number
}

interface BrowseDir {
  name: string
  path: string
}

function FolderBrowser({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<BrowseDir[]>([])
  const [loading, setLoading] = useState(true)

  const browse = useCallback(async (dirPath?: string) => {
    setLoading(true)
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''
      const res = await fetch(`/api/settings/browse${params}`)
      const data = await res.json()
      if (!res.ok) return
      setCurrent(data.current)
      setParent(data.parent)
      setDirs(data.directories)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { browse() }, [browse])

  return (
    <div className="border border-zinc-700 rounded-xl bg-zinc-800/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 bg-zinc-800">
        <p className="text-xs font-mono text-zinc-400 truncate flex-1 mr-2">{current}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onSelect(current)}
            className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition-colors"
          >
            Select this folder
          </button>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto">
        {parent && (
          <button
            onClick={() => browse(parent)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-700/50 transition-colors border-b border-zinc-800"
          >
            <ChevronUp size={14} className="text-zinc-500" />
            <span>..</span>
          </button>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="text-zinc-500 animate-spin" />
          </div>
        ) : dirs.length === 0 ? (
          <p className="text-xs text-zinc-600 text-center py-4">No subdirectories</p>
        ) : (
          dirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => browse(dir.path)}
              className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700/50 transition-colors group"
            >
              <Folder size={14} className="text-zinc-500 group-hover:text-indigo-400 transition-colors shrink-0" />
              <span className="truncate">{dir.name}</span>
              <ChevronRight size={12} className="text-zinc-600 ml-auto shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function ObsidianExportBlock({ onToast }: { onToast: (t: Toast) => void }) {
  const [vaultPath, setVaultPath] = useState('')
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<ObsidianResult | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        if (d.obsidianVaultPath) setSavedPath(d.obsidianVaultPath as string)
      })
      .catch(() => {})
  }, [])

  async function handleSavePath(pathToSave?: string) {
    const finalPath = pathToSave ?? vaultPath
    if (!finalPath.trim()) {
      onToast({ type: 'error', message: 'Enter a vault path first' })
      return
    }
    setSavingPath(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ obsidianVaultPath: finalPath.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      setSavedPath(finalPath.trim())
      setVaultPath(finalPath.trim())
      onToast({ type: 'success', message: 'Vault path saved' })
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save path' })
    } finally {
      setSavingPath(false)
    }
  }

  async function handleExport() {
    setExporting(true)
    setResult(null)
    try {
      const res = await fetch('/api/export/obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Export failed')
      setResult(data)
      onToast({ type: 'success', message: `Exported ${data.written} notes to Obsidian` })
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' })
    } finally {
      setExporting(false)
    }
  }

  function handleBrowseSelect(selectedPath: string) {
    setVaultPath(selectedPath)
    setBrowserOpen(false)
    handleSavePath(selectedPath)
  }

  return (
    <Section
      icon={BookOpen}
      title="Obsidian Export"
      description="Export bookmarks as Markdown notes with YAML frontmatter, wikilinks, and index files."
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-400 mb-1.5">Vault path</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <FolderOpen size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
                placeholder={savedPath ?? '/Users/you/ObsidianVault'}
                className="w-full pl-9 pr-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-xl text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 font-mono"
              />
            </div>
            <button
              onClick={() => setBrowserOpen(!browserOpen)}
              title="Browse folders"
              className="px-3 py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
            >
              <Folder size={16} />
            </button>
            <button
              onClick={() => handleSavePath()}
              disabled={savingPath || !vaultPath.trim()}
              className="px-4 py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-sm font-medium text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {savingPath ? 'Saving...' : 'Save'}
            </button>
          </div>
          {savedPath && (
            <p className="text-xs text-zinc-500 mt-1.5">
              Current: <code className="font-mono text-zinc-400">{savedPath}</code>
            </p>
          )}
        </div>

        {browserOpen && (
          <FolderBrowser
            onSelect={handleBrowseSelect}
            onClose={() => setBrowserOpen(false)}
          />
        )}

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500/50"
            />
            Overwrite existing notes
          </label>
        </div>

        <button
          onClick={handleExport}
          disabled={exporting || !savedPath}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {exporting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Download size={14} />
              Export to Obsidian
            </>
          )}
        </button>

        {result && (
          <div className="bg-zinc-800/50 border border-zinc-700 rounded-xl p-3 text-sm">
            <p className="text-green-400">{result.written} notes written</p>
            {result.skipped > 0 && <p className="text-zinc-400">{result.skipped} skipped (already exist)</p>}
            {result.indexesWritten > 0 && <p className="text-zinc-400">{result.indexesWritten} index files created</p>}
            {result.errors.length > 0 && <p className="text-red-400">{result.errors.length} errors</p>}
          </div>
        )}
      </div>
    </Section>
  )
}

function DataSection() {
  return (
    <Section
      icon={Database}
      title="Data Management"
      description="Export all your bookmarks and category data for backup or migration."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ExportButton
          label="Export as CSV"
          href="/api/export?type=csv"
          description="Spreadsheet-compatible format"
        />
        <ExportButton
          label="Export as JSON"
          href="/api/export?type=json"
          description="Full data with all fields"
        />
      </div>
    </Section>
  )
}

interface ArchiveStatusResponse {
  stats: { total: number; archived: number; complete: number; partial: number; failed: number; pending: number }
  job: {
    status: 'idle' | 'running' | 'stopping'
    total: number
    done: number
    complete: number
    partial: number
    failed: number
    current: string | null
    error: string | null
    waitingUntil: string | null
  }
  archiveDir: string
  defaultArchiveDir: string
  customArchiveDir: boolean
  inDocker: boolean
  diskUsageBytes: number | null
  xAccess: 'session' | 'guest'
  xLogin: { loggedIn: boolean; screenName: string | null; rejectedAt: string | null }
}

interface FolderListing {
  path: string
  parent: string | null
  home: string
  separator: string
  folders: string[]
  error: string | null
  suggestions: { label: string; path: string }[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

const ARCHIVE_SUBFOLDER = 'Siftly Archive'

function ArchiveFolderEditor({
  status,
  onDone,
  onCancel,
  onToast,
}: {
  status: ArchiveStatusResponse
  onDone: () => void
  onCancel: () => void
  onToast: (t: Toast) => void
}) {
  const [value, setValue] = useState(status.archiveDir)
  const [moveFiles, setMoveFiles] = useState(true)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = useCallback(async (dir?: string) => {
    try {
      const res = await fetch(`/api/archive/folders${dir ? `?path=${encodeURIComponent(dir)}` : ''}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not open that folder')
      setListing(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that folder')
    }
  }, [])

  // Load the cloud-folder suggestions up front
  useEffect(() => { void browse() }, [browse])

  const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${listing?.separator ?? '/'}${name}`

  async function save(archiveDir: string | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/archive', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archiveDir, moveFiles }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to change the folder')
      const parts = ['Archive folder changed.']
      if (data.moved?.moved) parts.push(`Moved ${data.moved.moved.toLocaleString()} file${data.moved.moved === 1 ? '' : 's'}.`)
      if (data.moved?.skipped) parts.push(`${data.moved.skipped.toLocaleString()} file${data.moved.skipped === 1 ? ' was' : 's were'} already there and left in the old folder.`)
      if (data.missing) parts.push(`${data.missing.toLocaleString()} bookmark${data.missing === 1 ? ' needs' : 's need'} downloading again — use Download on the dashboard.`)
      onToast({ type: 'success', message: parts.join(' ') })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change the folder')
    } finally {
      setSaving(false)
    }
  }

  const unchanged = value.trim() === status.archiveDir

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-800/30 p-3 space-y-3">
      {listing && listing.suggestions.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">Cloud folders on this computer</p>
          <div className="flex flex-wrap gap-1.5">
            {listing.suggestions.map((s) => (
              <button
                key={s.path}
                onClick={() => { setValue(join(s.path, ARCHIVE_SUBFOLDER)); setError(null) }}
                title={join(s.path, ARCHIVE_SUBFOLDER)}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-indigo-500/60 hover:text-zinc-100 transition-colors"
              >
                <Cloud size={12} className="text-sky-400" />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="archive-dir" className="text-xs text-zinc-500">Folder</label>
        <div className="mt-1 flex gap-2">
          <input
            id="archive-dir"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null) }}
            placeholder={listing ? join(join(listing.home, 'Google Drive'), ARCHIVE_SUBFOLDER) : ''}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={() => {
              const next = !browsing
              setBrowsing(next)
              if (next) void browse(value.trim() || undefined)
            }}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              browsing ? 'bg-indigo-600 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
            }`}
          >
            <FolderOpen size={13} /> Browse
          </button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          Pick a dedicated folder — one sub-folder is created inside it for each bookmark. It is created if it doesn&apos;t exist.
        </p>
      </div>

      {browsing && listing && (
        <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/70">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
            <button
              onClick={() => listing.parent && void browse(listing.parent)}
              disabled={!listing.parent}
              title="Up one folder"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
            >
              <CornerLeftUp size={14} />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400" title={listing.path}>{listing.path}</span>
            <button
              onClick={() => { setValue(listing.path); setError(null) }}
              className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Select
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {listing.error ? (
              <p className="px-3 py-2 text-xs text-zinc-500">{listing.error}</p>
            ) : listing.folders.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-500">No sub-folders</p>
            ) : (
              listing.folders.map((name) => (
                <button
                  key={name}
                  onClick={() => void browse(join(listing.path, name))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Folder size={13} className="shrink-0 text-zinc-500" />
                  <span className="truncate">{name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {status.stats.archived > 0 && (
        <label className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer">
          <input type="checkbox" checked={moveFiles} onChange={(e) => setMoveFiles(e.target.checked)} className="mt-0.5 accent-indigo-500" />
          <span>
            Move my {status.stats.archived.toLocaleString()} downloaded bookmark{status.stats.archived === 1 ? '' : 's'} to the new folder
            {!moveFiles && (
              <span className="block text-zinc-500">
                The old folder is left as it is. Bookmarks that aren&apos;t already in the new folder go back to &ldquo;not downloaded&rdquo;.
              </span>
            )}
          </span>
        </label>
      )}

      {status.inDocker && (
        <p className="flex items-start gap-2 text-[11px] text-amber-400">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          Siftly is running in Docker: this path is inside the container. Mount your cloud folder as a volume and enter its container path, or set SIFTLY_ARCHIVE_DIR.
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save(value.trim())}
          disabled={saving || !value.trim() || unchanged}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {saving ? (moveFiles && status.stats.archived > 0 ? 'Moving files…' : 'Saving…') : 'Save folder'}
        </button>
        <button onClick={onCancel} disabled={saving} className="rounded-lg px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50">
          Cancel
        </button>
        {status.customArchiveDir && (
          <button
            onClick={() => void save(null)}
            disabled={saving}
            title={status.defaultArchiveDir}
            className="ml-auto rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          >
            Back to default folder
          </button>
        )}
      </div>
    </div>
  )
}

function XLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

interface XLoginResponse {
  loggedIn: boolean
  account: {
    userId: string | null
    screenName: string | null
    source: 'browser' | 'manual'
    loggedInAt: string
    verified: boolean
  } | null
  rejectedAt: string | null
  login: {
    status: 'idle' | 'waiting' | 'saving' | 'success' | 'error' | 'cancelled'
    browser: string | null
    finishedAt: string | null
    message: string | null
    screenName: string | null
  }
  browserLogin: { available: boolean; browser: string | null; reason: string | null }
  remoteClient: boolean
  incompleteArchives: number
}

/** Tell the Local Archive section to refresh (login changed / a retry started) */
function notifyArchive() {
  window.dispatchEvent(new CustomEvent('siftly:archive-changed'))
}

function XLoginSection({ onToast }: { onToast: (t: Toast) => void }) {
  const [status, setStatus] = useState<XLoginResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'login' | 'cancel' | 'logout' | 'manual' | 'retry' | null>(null)
  const [showManual, setShowManual] = useState(false)
  const [authToken, setAuthToken] = useState('')
  const [ct0, setCt0] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [retryStarted, setRetryStarted] = useState(false)
  const [notice, setNotice] = useState<{ type: 'error' | 'info'; text: string } | null>(null)
  // onToast changes every render of the page; keep the polling below from restarting
  const toastRef = useRef(onToast)
  useEffect(() => { toastRef.current = onToast }, [onToast])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/x-account')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load X login status')
      setStatus(data)
      setLoadError(null)
      return data as XLoginResponse
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load X login status')
      return null
    }
  }, [])

  useEffect(() => {
    void load().then(() => {
      // Arriving from "Log in to X" links elsewhere in the app
      if (window.location.hash === '#x-login') document.getElementById('x-login')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [load])

  const loginStatus = status?.login.status
  const waiting = loginStatus === 'waiting' || loginStatus === 'saving'

  // Follow the login window; report how it ended
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(async () => {
      const data = await load()
      if (!data || data.login.status === 'waiting' || data.login.status === 'saving') return
      if (data.login.status === 'success') {
        toastRef.current({ type: 'success', message: data.login.screenName ? `Logged in to X as @${data.login.screenName}` : 'Logged in to X' })
        setNotice(null)
        notifyArchive()
      } else if (data.login.message) {
        setNotice({ type: data.login.status === 'error' ? 'error' : 'info', text: data.login.message })
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [waiting, load])

  async function request(kind: NonNullable<typeof busy>, url: string, init: RequestInit) {
    setBusy(kind)
    setNotice(null)
    try {
      const res = await fetch(url, init)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Request failed')
      return data
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Request failed' })
      return null
    } finally {
      setBusy(null)
    }
  }

  async function handleLogin() {
    setRetryStarted(false)
    if (await request('login', '/api/x-account/login', { method: 'POST' })) await load()
  }

  async function handleCancel() {
    if (await request('cancel', '/api/x-account/login', { method: 'DELETE' })) await load()
  }

  async function handleLogout() {
    if (await request('logout', '/api/x-account', { method: 'DELETE' })) {
      await load()
      notifyArchive()
      onToast({ type: 'success', message: 'Logged out of X in Siftly' })
    }
  }

  async function handleManualSave() {
    const data = await request('manual', '/api/x-account', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken, ct0 }),
    })
    if (!data) return
    setAuthToken('')
    setCt0('')
    setShowManual(false)
    setRetryStarted(false)
    await load()
    notifyArchive()
    if (data.warning) setNotice({ type: 'info', text: data.warning })
    onToast({ type: 'success', message: data.account?.screenName ? `Logged in to X as @${data.account.screenName}` : 'X login saved' })
  }

  async function handleRetry() {
    const data = await request('retry', '/api/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'retry' }),
    })
    if (data) {
      setRetryStarted(true)
      notifyArchive()
    }
  }

  const account = status?.account
  const handle = account?.screenName ?? (status?.login.status === 'success' ? status.login.screenName : null)

  const manualForm = (
    <div className="space-y-3 rounded-xl border border-zinc-700/60 bg-zinc-800/30 p-3">
      <div className="text-xs text-zinc-400 space-y-1">
        <p className="text-zinc-300">Copy two cookies from a browser where you&apos;re logged in to x.com:</p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>Open x.com, then Developer Tools (F12, or ⌥⌘I on a Mac).</li>
          <li>Chrome / Edge: <span className="text-zinc-300">Application → Cookies → https://x.com</span>. Firefox / Safari: <span className="text-zinc-300">Storage</span>.</li>
          <li>Copy the values of <code className="font-mono text-zinc-300">auth_token</code> and <code className="font-mono text-zinc-300">ct0</code>.</li>
        </ol>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-zinc-500">auth_token</span>
          <div className="relative mt-1">
            <input
              type={showToken ? 'text' : 'password'}
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 pr-8 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              aria-label={showToken ? 'Hide auth_token' : 'Show auth_token'}
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-zinc-500">ct0</span>
          <input
            value={ct0}
            onChange={(e) => setCt0(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void handleManualSave()}
          disabled={busy !== null || !authToken.trim() || !ct0.trim()}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy === 'manual' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {busy === 'manual' ? 'Checking with X…' : 'Save login'}
        </button>
        <p className="text-[11px] text-zinc-500">These cookies work like a password for your X account. They are stored only in your local Siftly database.</p>
      </div>
    </div>
  )

  return (
    <div id="x-login" className="scroll-mt-6">
      <Section
        icon={XLogo}
        title="X Login"
        description="Log in to your X account so Siftly can sync your bookmarks straight from X (Import → Sync from X), and the Local Archive can download what X only shows to logged-in users — above all the full text and images of X Articles."
      >
        {!status ? (
          loadError
            ? <p className="text-sm text-red-400">{loadError}</p>
            : <div className="h-16 rounded-xl bg-zinc-800/50 animate-pulse" />
        ) : (
          <div className="space-y-3">
            {waiting ? (
              <div className="flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 px-3 py-3">
                <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-indigo-400" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-zinc-200">
                    {loginStatus === 'saving'
                      ? 'Logged in — saving…'
                      : `Log in to X in the ${status.login.browser ?? 'browser'} window that just opened`}
                  </p>
                  {loginStatus === 'waiting' && (
                    <p className="mt-0.5 text-xs text-zinc-500">
                      It may be behind this window — check your taskbar or Dock. Siftly notices when you&apos;re logged in and closes the window by itself.
                    </p>
                  )}
                </div>
                {loginStatus === 'waiting' && (
                  <button
                    onClick={() => void handleCancel()}
                    disabled={busy !== null}
                    className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ) : status.loggedIn ? (
              <>
                <div className="flex items-center gap-3 rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-zinc-100">
                    <XLogo size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-100">
                      {handle ? <>Logged in as <span className="font-semibold">@{handle}</span></> : 'Logged in to X'}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {account?.source === 'browser' ? 'Logged in through the login window' : 'Cookies entered by hand'}
                      {account?.loggedInAt && <> · {new Date(account.loggedInAt).toLocaleDateString()}</>}
                      {account && !account.verified && ' · X couldn’t confirm the account when it was saved'}
                    </p>
                  </div>
                  <button
                    onClick={() => void handleLogout()}
                    disabled={busy !== null}
                    title="Forget this X login"
                    className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50 transition-colors"
                  >
                    {busy === 'logout' ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />} Log out
                  </button>
                </div>

                {status.rejectedAt && (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-300">
                    <AlertCircle size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      X stopped accepting this login on {new Date(status.rejectedAt).toLocaleDateString()} — it may have expired or been logged out on X.
                      {status.browserLogin.available
                        ? ' Log in again to keep downloading full articles.'
                        : ' Log out, then paste fresh cookies to keep downloading full articles.'}
                    </span>
                    {status.browserLogin.available && (
                      <button
                        onClick={() => void handleLogin()}
                        disabled={busy !== null}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500/20 px-2.5 py-1.5 font-medium text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                      >
                        <LogIn size={12} /> Log in again
                      </button>
                    )}
                  </div>
                )}

                {status.incompleteArchives > 0 && !status.rejectedAt && (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 px-3 py-2.5 text-xs text-zinc-300">
                    <Info size={14} className="shrink-0 text-indigo-400" />
                    <span className="min-w-0 flex-1">
                      {retryStarted
                        ? 'Retrying — follow the progress in Local Archive below.'
                        : `${status.incompleteArchives.toLocaleString()} downloaded bookmark${status.incompleteArchives === 1 ? ' is' : 's are'} incomplete, such as X Articles that only saved their preview. Retry ${status.incompleteArchives === 1 ? 'it' : 'them'} with your login.`}
                    </span>
                    {!retryStarted && (
                      <button
                        onClick={() => void handleRetry()}
                        disabled={busy !== null}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {busy === 'retry' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Retry now
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void handleLogin()}
                    disabled={busy !== null || !status.browserLogin.available}
                    className="flex items-center gap-2 rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {busy === 'login' ? <Loader2 size={15} className="animate-spin" /> : <XLogo size={14} />}
                    Log in to X
                  </button>
                  <button
                    onClick={() => setShowManual((v) => !v)}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    {showManual || !status.browserLogin.available ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    Paste cookies instead
                  </button>
                </div>
                {status.browserLogin.available ? (
                  <p className="text-xs text-zinc-500">
                    Opens {status.browserLogin.browser} in a separate window on x.com. You log in on X itself, so Siftly never sees your
                    password, and the window closes by itself once you&apos;re in.
                    {status.remoteClient && ' The window opens on the computer running Siftly, not on this device.'}
                  </p>
                ) : (
                  <p className="flex items-start gap-2 text-xs text-zinc-400">
                    <Info size={13} className="mt-0.5 shrink-0" />
                    <span>The login window isn&apos;t available here: {status.browserLogin.reason} Paste your X cookies instead.</span>
                  </p>
                )}
                {(showManual || !status.browserLogin.available) && manualForm}
              </>
            )}

            {notice && (
              <p className={`text-xs ${notice.type === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>{notice.text}</p>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

function LocalArchiveSection({ onToast }: { onToast: (t: Toast) => void }) {
  const [status, setStatus] = useState<ArchiveStatusResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editingFolder, setEditingFolder] = useState(false)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async (withUsage = false) => {
    try {
      const res = await fetch(`/api/archive${withUsage ? '?usage=1' : ''}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load archive status')
      setStatus((prev) => ({ ...data, diskUsageBytes: data.diskUsageBytes ?? prev?.diskUsageBytes ?? null }))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load archive status')
    }
  }, [])

  useEffect(() => { void load(true) }, [load])

  // The X Login section changed the login or started a retry
  useEffect(() => {
    const onChange = () => { void load() }
    window.addEventListener('siftly:archive-changed', onChange)
    return () => window.removeEventListener('siftly:archive-changed', onChange)
  }, [load])

  const running = status?.job.status === 'running' || status?.job.status === 'stopping'

  // Poll while a job runs; refresh disk usage once it finishes
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { void load() }, 1500)
    return () => {
      clearInterval(timer)
      void load(true)
    }
  }, [running, load])

  async function handleStart(mode: 'pending' | 'retry' | 'all') {
    setStarting(true)
    try {
      const res = await fetch('/api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to start')
      await load()
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to start downloading' })
    } finally {
      setStarting(false)
    }
  }

  async function handleStop() {
    await fetch('/api/archive', { method: 'DELETE' }).catch(() => {})
    await load()
  }

  const stats = status?.stats
  const job = status?.job
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0

  return (
    <Section
      icon={HardDrive}
      title="Local Archive"
      description="Download each bookmark's full text, images, videos and X Articles (with images in place) to a folder on your computer, so they stay readable even if the original is deleted from X. Nothing is downloaded automatically — use Download on the dashboard or the buttons below."
    >
      {!status ? (
        loadError
          ? <p className="text-sm text-red-400">{loadError}</p>
          : <div className="h-24 rounded-xl bg-zinc-800/50 animate-pulse" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-zinc-800/60 border border-zinc-700/50 px-3 py-2.5">
              <p className="text-lg font-semibold text-zinc-100 tabular-nums">{stats!.archived.toLocaleString()}<span className="text-xs text-zinc-500 font-normal"> / {stats!.total.toLocaleString()}</span></p>
              <p className="text-xs text-zinc-500">Downloaded</p>
            </div>
            <div className="rounded-xl bg-zinc-800/60 border border-zinc-700/50 px-3 py-2.5">
              <p className="text-lg font-semibold text-zinc-100 tabular-nums">{stats!.pending.toLocaleString()}</p>
              <p className="text-xs text-zinc-500">
                Not downloaded yet{stats!.failed > 0 && <span className="text-red-400"> · {stats!.failed.toLocaleString()} failed</span>}
              </p>
            </div>
            <div className="rounded-xl bg-zinc-800/60 border border-zinc-700/50 px-3 py-2.5">
              <p className={`text-lg font-semibold tabular-nums ${stats!.partial > 0 ? 'text-amber-400' : 'text-zinc-100'}`}>{stats!.partial.toLocaleString()}</p>
              <p className="text-xs text-zinc-500">Incomplete</p>
            </div>
          </div>

          {editingFolder ? (
            <ArchiveFolderEditor
              status={status}
              onToast={onToast}
              onCancel={() => setEditingFolder(false)}
              onDone={() => { setEditingFolder(false); void load(true) }}
            />
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2.5">
              <Folder size={15} className="mt-0.5 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500">
                  Archive folder
                  <span className={`ml-1.5 rounded px-1.5 py-px text-[10px] font-medium ${status.customArchiveDir ? 'bg-indigo-500/15 text-indigo-300' : 'bg-zinc-700/60 text-zinc-400'}`}>
                    {status.customArchiveDir ? 'Custom' : 'Default'}
                  </span>
                </p>
                <code className="block font-mono text-xs text-zinc-300 break-all">{status.archiveDir}</code>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {status.diskUsageBytes !== null && <>{formatBytes(status.diskUsageBytes)} used · </>}
                  Each bookmark gets its own folder with an <code className="font-mono">index.html</code> you can open without Siftly.
                </p>
              </div>
              <button
                onClick={() => setEditingFolder(true)}
                disabled={running}
                title={running ? 'Wait for the download to finish first' : 'Choose another folder, e.g. inside Google Drive'}
                className="shrink-0 rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Change
              </button>
            </div>
          )}

          {(() => {
            const { loggedIn, screenName, rejectedAt } = status.xLogin
            const tone = !loggedIn
              ? 'border-zinc-700/50 bg-zinc-800/40 text-zinc-400'
              : rejectedAt ? 'border-amber-500/30 bg-amber-500/5 text-amber-300' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
            return (
              <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${tone}`}>
                <Info size={13} className="shrink-0 mt-0.5" />
                <span className="min-w-0 flex-1">
                  {!loggedIn
                    ? 'Not logged in to X, so X Articles only save their preview.'
                    : rejectedAt
                      ? 'X stopped accepting your saved login, so X Articles only save their preview until you log in again.'
                      : `Logged in to X${screenName ? ` as @${screenName}` : ''}: full X Articles and posts are downloaded with your login.`}
                </span>
                {(!loggedIn || rejectedAt) && (
                  <a href="#x-login" className="shrink-0 font-medium text-indigo-400 hover:text-indigo-300">
                    {loggedIn ? 'Log in again' : 'Log in to X'}
                  </a>
                )}
              </div>
            )
          })()}

          {running && job ? (
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-zinc-200">
                  <Loader2 size={14} className="animate-spin text-indigo-400" />
                  {job.status === 'stopping' ? 'Stopping…' : `Downloading ${job.done.toLocaleString()} of ${job.total.toLocaleString()}`}
                  {job.current && job.status === 'running' && !job.waitingUntil && <span className="text-xs text-zinc-500 truncate">{job.current}</span>}
                </span>
                <button
                  onClick={() => void handleStop()}
                  disabled={job.status === 'stopping'}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                >
                  <Square size={10} /> Stop
                </button>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              {job.waitingUntil && job.status === 'running' && (
                <p className="text-xs text-zinc-400">
                  X&apos;s rate limit was reached — paused until {new Date(job.waitingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} so X Articles get their full text instead of a preview.
                </p>
              )}
              {(job.partial > 0 || job.failed > 0) && (
                <p className="text-xs text-amber-400">{job.partial} incomplete · {job.failed} failed so far</p>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void handleStart('pending')}
                disabled={starting || editingFolder || stats!.pending === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <HardDriveDownload size={14} />
                {stats!.pending > 0 ? `Download ${stats!.pending.toLocaleString()} bookmark${stats!.pending === 1 ? '' : 's'}` : 'Everything is downloaded'}
              </button>
              {stats!.partial + stats!.failed > 0 && (
                <button
                  onClick={() => void handleStart('retry')}
                  disabled={starting || editingFolder}
                  title="Download the incomplete and failed bookmarks again — with your X login, X Articles get their full text"
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-sm font-medium text-zinc-200 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={14} />
                  Retry {[
                    stats!.partial > 0 && `${stats!.partial.toLocaleString()} incomplete`,
                    stats!.failed > 0 && `${stats!.failed.toLocaleString()} failed`,
                  ].filter(Boolean).join(' + ')}
                </button>
              )}
              {stats!.archived > 0 && (
                <button
                  onClick={() => void handleStart('all')}
                  disabled={starting || editingFolder}
                  className="px-3 py-2.5 rounded-xl text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  title="Fetch every bookmark again and fill in anything missing. Existing files are kept."
                >
                  Refresh all
                </button>
              )}
            </div>
          )}
          {job?.error && !running && <p className="text-xs text-red-400">Last run: {job.error}</p>}
        </div>
      )}
    </Section>
  )
}

function DangerZoneSection({ onToast }: { onToast: (t: Toast) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  async function handleClearAll() {
    setClearing(true)
    try {
      const res = await fetch('/api/bookmarks', { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? 'Failed to clear')
      }
      onToast({ type: 'success', message: 'All bookmarks deleted successfully' })
      setConfirming(false)
      setCleared(true)
      setTimeout(() => setCleared(false), 3000)
      window.dispatchEvent(new CustomEvent('siftly:cleared'))
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to clear bookmarks' })
    } finally {
      setClearing(false)
    }
  }

  return (
    <Section
      icon={Shield}
      title="Danger Zone"
      description="Irreversible actions that affect all your data."
      variant="danger"
    >
      <div className="flex items-center justify-between p-4 rounded-xl bg-red-900/20 border border-red-800/40">
        <div>
          <p className="text-sm font-medium text-zinc-300">Clear all bookmarks</p>
          <p className="text-xs text-zinc-500 mt-0.5">Permanently delete all imported bookmarks</p>
        </div>
        {cleared ? (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
            <Check size={14} />
            Cleared
          </div>
        ) : !confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-red-400 bg-red-800/30 hover:bg-red-700/40 border border-red-700/50 hover:border-red-600/60 transition-all"
          >
            <Trash2 size={14} />
            Clear all
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 mr-1">Are you sure?</span>
            <button
              onClick={() => setConfirming(false)}
              disabled={clearing}
              className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleClearAll()}
              disabled={clearing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} />
              {clearing ? 'Deleting…' : 'Yes, delete all'}
            </button>
          </div>
        )}
      </div>
    </Section>
  )
}

const TECH_STACK = [
  { label: 'Next.js 15', color: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
  { label: 'Prisma + SQLite', color: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
  { label: 'Anthropic / OpenAI / MiniMax', color: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  { label: 'React Flow', color: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
  { label: 'Tailwind CSS', color: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
]

const DONATION_ADDRESS = '0xcF10B967a9e422753812004Cd59990f62E360760'

function AboutSection() {
  const [copied, setCopied] = useState(false)

  function copyAddress() {
    void navigator.clipboard.writeText(DONATION_ADDRESS).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Section icon={Info} title="About Siftly" description="Self-hosted Twitter bookmark manager">
      <p className="text-sm text-zinc-400 leading-relaxed mb-5">
        <strong className="text-zinc-100 font-semibold">Siftly</strong> is a self-hosted app for
        organizing your Twitter/X bookmarks. Use the built-in bookmarklet or console script to import,
        then run the 4-stage AI pipeline to analyze images, extract entities, generate semantic tags, and
        auto-categorize — then explore connections through the interactive mindmap.
      </p>

      {/* Builder + support row */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Built by */}
        <a
          href="https://x.com/viperr"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800 transition-all group flex-1"
        >
          <span className="text-base leading-none">𝕏</span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-zinc-200 group-hover:text-white transition-colors">@viperr</p>
            <p className="text-[11px] text-zinc-600">Built &amp; open-sourced by</p>
          </div>
          <ExternalLink size={12} className="text-zinc-600 group-hover:text-zinc-400 transition-colors ml-auto shrink-0" />
        </a>

        {/* Donate */}
        <div className="flex-1 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20">
          <div className="flex items-center gap-2 mb-2">
            <Coffee size={13} className="text-amber-400 shrink-0" />
            <span className="text-xs font-semibold text-amber-300">Support development</span>
          </div>
          <p className="text-[11px] text-zinc-500 mb-2.5 leading-relaxed">
            If Siftly saves you time, consider leaving a tip
          </p>
          <button
            onClick={copyAddress}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-900/60 border border-amber-500/20 hover:border-amber-500/50 hover:bg-zinc-900 transition-all group"
          >
            <span className="text-[10px] font-mono text-zinc-400 group-hover:text-zinc-200 transition-colors truncate">
              {DONATION_ADDRESS}
            </span>
            {copied
              ? <Check size={13} className="text-emerald-400 shrink-0" />
              : <Copy size={13} className="text-zinc-600 group-hover:text-amber-400 transition-colors shrink-0" />
            }
          </button>
          {copied && (
            <p className="text-[10px] text-emerald-400 mt-1.5 text-center">Address copied!</p>
          )}
        </div>
      </div>
    </Section>
  )
}

function XOAuthSection({ onToast }: { onToast: (t: Toast) => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [savedSecret, setSavedSecret] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        if (d.hasXOAuth && d.xOAuthClientId) setSavedId(d.xOAuthClientId as string)
        if (d.xOAuthClientSecret) setSavedSecret(d.xOAuthClientSecret as string)
      })
      .catch(() => {})
  }, [])

  async function handleSave() {
    if (!clientId.trim()) {
      onToast({ type: 'error', message: 'Client ID is required' })
      return
    }
    setSaving(true)
    try {
      const payload: Record<string, string> = { xOAuthClientId: clientId.trim() }
      if (clientSecret.trim()) payload.xOAuthClientSecret = clientSecret.trim()
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? 'Failed to save')
      }
      setSavedId(clientId.trim().slice(0, 6) + '••••' + clientId.trim().slice(-4))
      if (clientSecret.trim()) setSavedSecret(clientSecret.trim().slice(0, 4) + '••••')
      setClientId('')
      setClientSecret('')
      onToast({ type: 'success', message: 'X OAuth credentials saved' })
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save' })
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    try {
      await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'x_oauth_client_id' }),
      })
      await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'x_oauth_client_secret' }),
      })
      setSavedId(null)
      setSavedSecret(null)
      onToast({ type: 'success', message: 'X OAuth credentials removed' })
    } catch (err) {
      onToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to remove' })
    }
  }

  const callbackUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/import/x-oauth/callback`
    : '/api/import/x-oauth/callback'

  return (
    <Section
      icon={Shield}
      title="X (Twitter) OAuth 2.0"
      description="Connect your X account to import bookmarks using the official API."
    >
      <div className="space-y-4">
        {savedId ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
              <div className="flex items-center gap-2.5">
                <Check size={15} className="text-emerald-400 shrink-0" />
                <div className="text-sm">
                  <span className="text-emerald-300">Client ID: </span>
                  <span className="text-zinc-400 font-mono text-xs">{savedId}</span>
                  {savedSecret && (
                    <>
                      <span className="text-zinc-600 mx-2">·</span>
                      <span className="text-emerald-300">Secret: </span>
                      <span className="text-zinc-400 font-mono text-xs">{savedSecret}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={handleRemove}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Remove X OAuth credentials"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 font-mono"
              />
              <input
                type="password"
                placeholder="Client Secret (optional for public clients)"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 font-mono"
              />
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !clientId.trim()}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
              {saving ? 'Saving...' : 'Save X OAuth Credentials'}
            </button>
          </div>
        )}

        <div className="text-xs text-zinc-600 space-y-1">
          <p>
            Get credentials from the{' '}
            <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
              X Developer Portal
            </a>
          </p>
          <p>
            Callback URL: <code className="bg-zinc-800 px-1.5 py-0.5 rounded font-mono text-zinc-400">{callbackUrl}</code>
          </p>
        </div>
      </div>
    </Section>
  )
}

export default function SettingsPage() {
  const [toast, setToast] = useState<Toast | null>(null)

  function showToast(t: Toast) {
    setToast(t)
    setTimeout(() => setToast(null), 4000)
  }

  return (
    <div className="p-6 md:p-8 max-w-2xl mx-auto">

      {/* Page Header */}
      <div className="mb-8">
        <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium mb-1">Configuration</p>
        <h1 className="text-2xl font-bold text-zinc-100">Settings</h1>
        <p className="text-zinc-400 mt-1 text-sm">Configure your Siftly instance</p>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mb-6">
          <ToastAlert toast={toast} />
        </div>
      )}

      <div className="space-y-4">
        <ApiKeySection onToast={showToast} />
        <XOAuthSection onToast={showToast} />
        <DataSection />
        <XLoginSection onToast={showToast} />
        <LocalArchiveSection onToast={showToast} />
        <ObsidianExportBlock onToast={showToast} />
        <DangerZoneSection onToast={showToast} />
        <AboutSection />
      </div>
    </div>
  )
}
