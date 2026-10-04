import { NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { resolveProxyClient, listProxyModels } from '@/lib/proxy-auth'

/**
 * GET — list the models exposed by the configured local proxy (`GET {baseURL}/models`).
 */
export async function GET(): Promise<NextResponse> {
  const [keySetting, urlSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'proxyApiKey' } }),
    prisma.setting.findUnique({ where: { key: 'proxyBaseUrl' } }),
  ])

  let client
  try {
    client = resolveProxyClient({ dbKey: keySetting?.value, baseURL: urlSetting?.value })
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid proxy URL: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    )
  }

  try {
    const models = await listProxyModels(client)
    return NextResponse.json({ models })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const friendly = msg.includes('401') || msg.includes('invalid_api_key')
      ? 'Invalid API key — check the key configured in your proxy'
      : msg.includes('ECONNREFUSED') || msg.toLowerCase().includes('connection error')
      ? 'Could not reach proxy — is it running?'
      : msg.slice(0, 200)
    return NextResponse.json({ error: friendly }, { status: 502 })
  }
}
