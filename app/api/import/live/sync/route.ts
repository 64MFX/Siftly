import { NextResponse } from 'next/server'
import { syncBookmarks, isSyncing } from '@/lib/x-sync'
import { getXCredentials } from '@/lib/x-session'

/** POST — sync bookmarks from X now with the saved X login, and wait for it */
export async function POST() {
  if (isSyncing()) {
    return NextResponse.json({ error: 'A sync is already in progress' }, { status: 409 })
  }

  try {
    if (!(await getXCredentials())) {
      return NextResponse.json(
        { error: 'X credentials not configured. Log in to X in Settings → X Login first.' },
        { status: 400 },
      )
    }

    const result = await syncBookmarks()
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed'
    const status = msg.includes('already in progress') ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
