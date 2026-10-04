import { describe, it, expect } from 'vitest'
import { readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { PassThrough } from 'stream'
import { browserCandidates, CdpPipe, findBrowser, getXLoginState, pickXSession, startXLogin, XLoginError } from '@/lib/x-login'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('findBrowser', () => {
  it('finds Chrome on macOS, also in ~/Applications', () => {
    const exists = (p: string) => p === '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(findBrowser({}, 'darwin', exists, '/Users/me')?.name).toBe('Google Chrome')
    expect(browserCandidates('darwin', {}, '/Users/me')[0].path).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('finds Edge on Windows under Program Files (x86)', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    expect(findBrowser(env, 'win32', (p) => p === edge)).toEqual({ name: 'Microsoft Edge', path: edge })
  })

  it('searches PATH on Linux and only falls back to snap packages', () => {
    const env = { PATH: '/snap/bin:/usr/bin' }
    const found = findBrowser(env, 'linux', (p) => p === '/snap/bin/chromium' || p === '/usr/bin/chromium-browser')
    expect(found).toEqual({ name: 'Chromium', path: '/usr/bin/chromium-browser' })
    expect(findBrowser(env, 'linux', (p) => p === '/snap/bin/chromium')?.path).toBe('/snap/bin/chromium')
  })

  it('uses SIFTLY_BROWSER_PATH when set, and nothing else if it is missing', () => {
    const env = { SIFTLY_BROWSER_PATH: '/opt/custom/brave', PATH: '/usr/bin' }
    expect(findBrowser(env, 'linux', (p) => p === '/opt/custom/brave')).toEqual({ name: 'brave', path: '/opt/custom/brave' })
    expect(findBrowser(env, 'linux', (p) => p === '/usr/bin/google-chrome')).toBeNull()
  })

  it('returns null when no browser is installed', () => {
    expect(findBrowser({ PATH: '/usr/bin' }, 'linux', () => false)).toBeNull()
  })
})

describe('pickXSession', () => {
  it('waits for both auth_token and ct0 on x.com', () => {
    const guest = [{ name: 'ct0', value: 'guest', domain: '.x.com' }, { name: 'guest_id', value: 'v1', domain: '.x.com' }]
    expect(pickXSession(guest)).toBeNull()
    const loggedIn = [
      ...guest,
      { name: 'auth_token', value: 'other-site', domain: '.example.com' },
      { name: 'auth_token', value: 'tok', domain: '.x.com' },
      { name: 'twid', value: 'u%3D42', domain: 'x.com' },
    ]
    expect(pickXSession(loggedIn)).toEqual({ authToken: 'tok', ct0: 'guest', twid: 'u%3D42' })
  })

  it('ignores look-alike domains', () => {
    const cookies = [
      { name: 'auth_token', value: 'tok', domain: '.notx.com' },
      { name: 'ct0', value: 'c', domain: '.notx.com' },
    ]
    expect(pickXSession(cookies)).toBeNull()
  })
})

describe('CdpPipe', () => {
  function pipe() {
    const toBrowser = new PassThrough()
    const fromBrowser = new PassThrough()
    const written: string[] = []
    toBrowser.on('data', (d: Buffer) => written.push(d.toString('utf8')))
    return { cdp: new CdpPipe(toBrowser, fromBrowser), fromBrowser, written }
  }

  it('sends NUL-terminated commands and matches replies split across chunks', async () => {
    const { cdp, fromBrowser, written } = pipe()
    const reply = cdp.send('Storage.getCookies')
    await tick()
    expect(written.join('')).toBe('{"id":1,"method":"Storage.getCookies","params":{}}\0')

    const bytes = Buffer.from(
      '{"method":"Target.targetCreated","params":{}}\0{"id":1,"result":{"cookies":[{"name":"n","value":"é","domain":".x.com"}]}}\0',
    )
    const cut = bytes.indexOf(Buffer.from('é')) + 1 // split inside the two-byte character
    fromBrowser.write(bytes.subarray(0, cut))
    fromBrowser.write(bytes.subarray(cut))
    await expect(reply).resolves.toEqual({ cookies: [{ name: 'n', value: 'é', domain: '.x.com' }] })
  })

  it('rejects DevTools errors, and everything pending once the browser closes', async () => {
    const { cdp, fromBrowser } = pipe()
    const bad = cdp.send('Nope.method')
    const pending = cdp.send('Target.getTargets')
    await tick()
    fromBrowser.write('{"id":1,"error":{"message":"\'Nope.method\' wasn\'t found"}}\0')
    await expect(bad).rejects.toThrow("'Nope.method' wasn't found")
    fromBrowser.destroy()
    await expect(pending).rejects.toThrow('The browser closed')
    await expect(cdp.send('Storage.getCookies')).rejects.toThrow('The browser closed')
  })

  it('times out commands the browser never answers', async () => {
    const { cdp } = pipe()
    await expect(cdp.send('Storage.getCookies', {}, 20)).rejects.toThrow('Storage.getCookies timed out')
  })
})

describe('startXLogin', () => {
  const missingBrowser = { name: 'Nowhere Browser', path: '/nonexistent/siftly-test-browser' }
  const loginProfiles = async () => (await readdir(tmpdir())).filter((d) => d.startsWith('siftly-x-login-')).length

  async function settled() {
    for (let i = 0; i < 100; i++) {
      const state = getXLoginState()
      if (state.status !== 'waiting' && state.status !== 'saving') return state
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return getXLoginState()
  }

  it('opens only one login window at a time, and reports a browser that fails to start', async () => {
    const before = await loginProfiles()
    const first = startXLogin({ browser: missingBrowser, onLoggedIn: async () => ({ screenName: null }) })
    // A second click while the first is still starting is refused
    await expect(startXLogin({ browser: missingBrowser, onLoggedIn: async () => ({ screenName: null }) })).rejects.toBeInstanceOf(XLoginError)
    await first

    const state = await settled()
    expect(state.status).toBe('error')
    expect(state.message).toMatch(/^Couldn't open Nowhere Browser: .*ENOENT/)
    expect(await loginProfiles()).toBe(before) // the temporary profile is gone
  })
})
