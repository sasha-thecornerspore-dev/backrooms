// src/main.js under a fake Electron: the update check's failure is logged, never an
// unhandled rejection (PKG-1). No server is started here (HOST LAN is covered by lan.test.js,
// which binds 127.0.0.1 only).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const h = vi.hoisted(() => ({
  userData: null,
  handlers: new Map(),
  appEvents: new Map(),
  updater: null,
  ready: null,
  clipboard: [],
  clipboardRefuses: false,   // Electron 44: writeText returns a promise, which can reject
  checkCalls: 0,    // how many times the launch check ran, read in beforeAll: Vitest 5 clears mock state between tests
}))

vi.mock('electron', () => {
  const app = {
    isPackaged: true,
    getPath: () => h.userData,
    getVersion: () => '0.0.0-test',
    disableHardwareAcceleration: () => {},
    whenReady: () => { h.ready = Promise.resolve(); return h.ready },
    on: (ev, fn) => { h.appEvents.set(ev, fn) },
    quit: () => {},
  }
  class BrowserWindow {
    constructor() { this.webContents = { on: () => {}, send: () => {} } }
    loadFile() {}
    on() {}
    isDestroyed() { return false }
  }
  return {
    app, BrowserWindow,
    ipcMain: { handle: (ch, fn) => h.handlers.set(ch, fn), on: () => {} },
    shell: { openExternal: () => {} },
    clipboard: { writeText: (t) => h.clipboardRefuses ? Promise.reject(new Error('clipboard refused')) : (h.clipboard.push(t), Promise.resolve()) },
  }
})

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('events')
  const autoUpdater = new EventEmitter()
  autoUpdater.checkForUpdates = vi.fn(() => {
    const e = Object.assign(new Error('ENOENT: no such file, open C:\\somewhere\\app-update.yml'), { code: 'ENOENT' })
    return Promise.reject(e)
  })
  autoUpdater.quitAndInstall = () => {}
  h.updater = autoUpdater
  return { default: { autoUpdater } }
})

const unhandled = []
const onUnhandled = (e) => unhandled.push(e)
let logFile

beforeAll(async () => {
  h.userData = mkdtempSync(path.join(tmpdir(), 'backrooms-main-test-'))
  logFile = path.join(h.userData, 'backrooms.log')
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await import('../src/main.js')
  await h.ready
  // the check runs at the end of app.whenReady()'s chain; wait for it (and its rejection to be logged) rather than a fixed
  // 50 ms, which Vitest 5's slower module graph outran (the check itself still fires once, which the first test pins)
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const logged = existsSync(logFile) && readFileSync(logFile, 'utf8').includes('update check failed')
    if (h.updater && h.updater.checkForUpdates.mock.calls.length > 0 && logged) break
    await new Promise((r) => setTimeout(r, 20))
  }
  await new Promise((r) => setTimeout(r, 20))
  h.checkCalls = h.updater.checkForUpdates.mock.calls.length
})

afterAll(async () => {
  const quit = h.appEvents.get('before-quit')
  if (quit) quit()
  await new Promise((r) => setTimeout(r, 50))
  process.off('unhandledRejection', onUnhandled)
  try { rmSync(h.userData, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('update check (PKG-1)', () => {
  it('logs "update check failed: <code>" and raises no unhandled rejection', () => {
    expect(h.checkCalls).toBe(1)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(log).toContain('update check failed: ENOENT')
    expect(log).not.toContain('unhandledRejection')
    expect(log).not.toContain('somewhere')
    expect(unhandled).toEqual([])
  })

  it("logs the updater's 'error' event the same way", () => {
    h.updater.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' }))
    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain('update check failed: ENOTFOUND')
    expect(log).not.toContain('example.invalid')
  })
})

describe('fire-beacon (an anchored beacon carries the pin)', () => {
  it('accepts an anchor in the payload; the off effect returns before any network', async () => {
    const fire = h.handlers.get('fire-beacon')
    expect(typeof fire).toBe('function')
    await expect(fire(null, { effect: 'off', webhook: '', anchor: { lat: 39.2994, lng: -76.641 } }))
      .resolves.toEqual({ ok: false, skipped: true })
  })

  it('src/main.js destructures the anchor and hands it to fireBeacon', () => {
    const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    expect(src).toMatch(/const \{ effect, webhook, anchor \} = payload \|\| \{\}/)
    expect(src).toMatch(/fireBeacon\(effect, webhook, \{ appVersion: app\.getVersion\(\), now, anchor \}\)/)
  })
})

// The wish no longer goes to GitHub from here: the app posts { text, meta, version } to the relay's /wish, and the relay
// (relay/wishgate.js buildIssue) builds the title from the first line and the labels from the trailer — W8's guards, repointed.
describe('submit-wish (W8: the title from the first line, the labels from the trailer — built by the relay now)', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8')
  const gate = readFileSync(new URL('../relay/wishgate.js', import.meta.url), 'utf8')

  it('src/main.js hands text and meta to the relay; the relay hands them to the pure label builder', () => {
    expect(main).toContain("ipcMain.handle('submit-wish', async (_event, text, meta) =>")
    expect(main).toContain('postWish(text, meta, { version: app.getVersion() })')
    expect(gate).toContain('title: wishTitle(text)')
    expect(gate).toContain('labels: wishLabels(text, meta)')
    expect(gate).toContain("from '../src/wish-labels.js'")
    expect(gate).toContain('`${text}' + String.raw`\n\n---\nsubmitted from backrooms v` + '${appVersion}`')
    expect(main).not.toContain("labels: ['wish', 'pending']")
    expect(gate).not.toContain("labels: ['wish', 'pending']")
  })

  it('preload.cjs bridges two arguments', () => {
    expect(preload).toContain("submitWish: (text, meta) => ipcRenderer.invoke('submit-wish', text, meta)")
  })

  it('the handler posts text, meta and the app version to the relay, and hands back its answer', async () => {
    const submit = h.handlers.get('submit-wish')
    expect(typeof submit).toBe('function')
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, number: 12 }), { status: 201 }))
    vi.stubGlobal('fetch', f)
    try {
      const text = 'make the fog warmer\nfiled under: EXTENSION · level 2'
      await expect(submit(null, text, { origin: 'processed' })).resolves.toEqual({ ok: true, number: 12 })
      const [url, init] = f.mock.calls[0]
      expect(url).toBe('https://backrooms-relay.jeff-schatz112.workers.dev/wish')
      expect(JSON.parse(init.body)).toEqual({ text, meta: { origin: 'processed' }, version: '0.0.0-test' })
      expect(JSON.stringify(init)).not.toMatch(/Bearer|token/i)
    } finally { vi.unstubAllGlobals() }
  })

  it('a dev run (not packaged) stays a silent no-op and sends nothing', async () => {
    const { app } = await import('electron')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    app.isPackaged = false
    try {
      await expect(h.handlers.get('submit-wish')(null, 'let me out', { origin: null })).resolves.toBeUndefined()
      expect(f).not.toHaveBeenCalled()
    } finally { app.isPackaged = true; vi.unstubAllGlobals() }
  })
})

describe('copy-invite (growth-spec §1.6: the desktop copies an invite through main, and only our own /play/ link)', () => {
  const OK = 'https://backrooms.thecornerspore.dev/play/?room=yellow-lamp-42'
  it('copies a /play/ invite, the pin included, and says so', async () => {
    const copy = h.handlers.get('copy-invite')
    expect(typeof copy).toBe('function')
    h.clipboard.length = 0
    expect(await copy(null, OK)).toBe(true)
    expect(await copy(null, OK + '&anchor=39.2854%2C-76.6083')).toBe(true)
    expect(h.clipboard).toEqual([OK, OK + '&anchor=39.2854%2C-76.6083'])
  })
  it('anything else from the page is refused and nothing is written', async () => {
    const copy = h.handlers.get('copy-invite')
    h.clipboard.length = 0
    for (const bad of ['https://evil.example/play/?room=x', 'hello', OK + 'x'.repeat(300), null, 42, { url: OK },
      'http://backrooms.thecornerspore.dev/play/?room=x', 'https://backrooms.thecornerspore.dev.evil.example/play/?room=x']) {
      expect(await copy(null, bad), String(bad)).toBe(false)
    }
    expect(h.clipboard).toEqual([])
  })
  it('a clipboard that refuses the write answers false, so the page offers the link by hand', async () => {
    const copy = h.handlers.get('copy-invite')
    h.clipboard.length = 0
    h.clipboardRefuses = true
    try {
      expect(await copy(null, OK)).toBe(false)
      expect(h.clipboard).toEqual([])
    } finally { h.clipboardRefuses = false }
  })
})
