// src/updater.js: the auto / notify / manual update modes against a fake electron-updater.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createUpdateController, normalizeMode, RECHECK_MS } from '../src/updater.js'

function rig({ mode = 'auto', platform = 'win32', enabled = true, check } = {}) {
  const au = new EventEmitter()
  au.checkForUpdates = vi.fn(check || (() => Promise.resolve()))
  au.downloadUpdate = vi.fn(() => Promise.resolve())
  au.quitAndInstall = vi.fn()
  const sent = []
  const timers = []
  const s = { mode }
  const ctl = createUpdateController({
    autoUpdater: au,
    getMode: () => s.mode,
    send: (st) => sent.push(st),
    log: vi.fn(),
    openReleases: vi.fn(),
    platform,
    enabled,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearInterval: (t) => { t.cleared = true },
  })
  return { au, ctl, sent, timers, s, last: () => sent[sent.length - 1] }
}

describe('normalizeMode', () => {
  it('passes known modes and defaults the rest to auto', () => {
    expect(normalizeMode('notify')).toBe('notify')
    expect(normalizeMode('manual')).toBe('manual')
    expect(normalizeMode(undefined)).toBe('auto')
    expect(normalizeMode('bogus')).toBe('auto')
  })
})

describe('auto mode', () => {
  it('checks on start with autoDownload on, and schedules re-checks', async () => {
    const { au, ctl, timers } = rig({ mode: 'auto' })
    ctl.start()
    await Promise.resolve(); await Promise.resolve()
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(au.autoDownload).toBe(true)
    expect(au.autoInstallOnAppQuit).toBe(true)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(RECHECK_MS)
  })

  it('reports downloading -> downloaded, and installs only when asked', () => {
    const { au, ctl, last } = rig({ mode: 'auto' })
    au.autoDownload = true
    au.emit('update-available', { version: '9.9.9' })
    expect(last()).toEqual({ state: 'downloading', version: '9.9.9', percent: 0 })
    au.emit('download-progress', { percent: 41.6 })
    expect(last()).toEqual({ state: 'downloading', version: '9.9.9', percent: 42 })
    au.emit('update-downloaded', { version: '9.9.9' })
    expect(last()).toEqual({ state: 'downloaded', version: '9.9.9' })
    expect(au.quitAndInstall).not.toHaveBeenCalled()   // never yanks a player out mid-run
    ctl.restart()
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})

describe('notify mode', () => {
  it('checks without downloading, then downloads on request', async () => {
    const { au, ctl, last } = rig({ mode: 'notify' })
    await ctl.check()
    expect(au.autoDownload).toBe(false)
    au.emit('update-available', { version: '2.0.0' })
    expect(last()).toEqual({ state: 'available', version: '2.0.0', manual: false })
    await ctl.download()
    expect(au.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(last().state).toBe('downloading')
  })

  it('download() is a no-op when nothing is available', async () => {
    const { au, ctl } = rig({ mode: 'notify' })
    await ctl.download()
    expect(au.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('manual mode', () => {
  it('never checks or schedules on its own, but the button still checks', async () => {
    const { au, ctl, timers, last } = rig({ mode: 'manual' })
    ctl.start()
    expect(au.checkForUpdates).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
    await ctl.check()
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(au.autoDownload).toBe(false)
    au.emit('update-not-available')
    expect(last()).toEqual({ state: 'up-to-date' })
  })

  it('switching modes re-arms or cancels the schedule', () => {
    const { ctl, timers, s } = rig({ mode: 'auto' })
    ctl.applyMode()
    expect(timers).toHaveLength(1)
    s.mode = 'manual'
    ctl.applyMode()
    expect(timers[0].cleared).toBe(true)
    expect(timers).toHaveLength(1)
    s.mode = 'notify'
    ctl.applyMode()
    expect(timers).toHaveLength(2)
  })
})

describe('failures', () => {
  it('a rejected check is logged by code and surfaces as an error state, never a rejection', async () => {
    const { ctl, last } = rig({ check: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND host.invalid'), { code: 'ENOTFOUND' })) })
    await expect(ctl.check()).resolves.toBeDefined()
    expect(last()).toEqual({ state: 'error', error: 'ENOTFOUND' })
  })

  it('does not re-check over a download in progress', async () => {
    const { au, ctl } = rig({ mode: 'auto' })
    au.autoDownload = true
    au.emit('update-available', { version: '3.0.0' })
    await ctl.check()
    expect(au.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('macOS (unsigned builds)', () => {
  it('never downloads in-app: offers the release page instead', async () => {
    const { au, ctl, last } = rig({ mode: 'auto', platform: 'darwin' })
    await ctl.check()
    expect(au.autoDownload).toBe(false)
    expect(au.autoInstallOnAppQuit).toBe(false)
    au.emit('update-available', { version: '4.0.0' })
    expect(last()).toEqual({ state: 'available', version: '4.0.0', manual: true })
    await ctl.download()
    expect(au.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('dev builds', () => {
  it('report unsupported and never touch the network', async () => {
    const { au, ctl, timers } = rig({ enabled: false })
    ctl.start()
    await ctl.check()
    expect(au.checkForUpdates).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
    expect(ctl.getStatus()).toEqual({ state: 'unsupported' })
  })
})
