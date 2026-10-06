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
  }
})

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('events')
  const autoUpdater = new EventEmitter()
  autoUpdater.checkForUpdatesAndNotify = vi.fn(() => {
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
  await new Promise((r) => setTimeout(r, 50))
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
    expect(h.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
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
