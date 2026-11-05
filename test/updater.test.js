// src/updater.js: the auto / notify / manual update modes against a fake electron-updater.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'node:fs'
import { createUpdateController, normalizeMode, RECHECK_MS } from '../src/updater.js'

const read = (p) => { try { return fs.readFileSync(new URL(p, import.meta.url), 'utf8') } catch { return null } }

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

  // in auto mode electron-updater starts the download inside the check and hands its promise back (downloadPromise). When the download
  // fails it has already said so through the error event; on 2.0.3 nobody caught the promise, and each failure also landed in the log
  // as an unhandled rejection, raw certificate and all
  it('a download that fails after an auto check is told once, by the error event, and is never an unhandled rejection', async () => {
    const err = Object.assign(new Error('New version 9.9.9 is not signed by the application owner'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' })
    const unhandled = []
    const note = (e) => unhandled.push(e)
    process.on('unhandledRejection', note)
    try {
      const r = rig({ mode: 'auto', check: () => { r.au.emit('error', err); return Promise.resolve({ downloadPromise: Promise.reject(err) }) } })
      await expect(r.ctl.check()).resolves.toBeDefined()
      await new Promise((done) => setTimeout(done, 0))                 // long enough for node to notice a rejection nobody holds
      expect(unhandled).toEqual([])
      expect(r.sent.filter((s) => s.state === 'error')).toEqual([{ state: 'error', error: 'ERR_UPDATER_INVALID_SIGNATURE' }])
    } finally { process.off('unhandledRejection', note) }
  })
  it('a check that hands back no download (notify, manual, nothing new) is left alone', async () => {
    for (const result of [undefined, null, {}, { downloadPromise: null }]) {
      const { ctl } = rig({ mode: 'notify', check: () => Promise.resolve(result) })
      await expect(ctl.check()).resolves.toBeDefined()
    }
  })
})

// 2.0.3 to 2.0.5 could not update themselves on Windows (ERR_UPDATER_INVALID_SIGNATURE). The installer is signed by the project's own CA,
// which no player's Windows trusts; a build made with the publisher check on carries the publisher's name (app-update.yml), and such a
// build takes only an update whose signature Windows calls Valid. With the check off no name is written, and the updater goes by the
// installer's sha512 from latest.yml, as it does on Linux.
describe('the Windows build does not ask its updater to check the publisher', () => {
  const pkg = JSON.parse(read('../package.json'))
  it('build.win.verifyUpdateCodeSignature is false, and no publisher name is set by hand anywhere', () => {
    expect(pkg.build.win.verifyUpdateCodeSignature).toBe(false)
    expect(JSON.stringify(pkg.build)).not.toContain('publisherName')
  })
  // the one line works only through these two rules of the libraries; a version that changes either fails here and is read again
  const schema = read('../node_modules/app-builder-lib/scheme.json')
  const packager = read('../node_modules/app-builder-lib/out/winPackager.js')
  const publish = read('../node_modules/app-builder-lib/out/publish/PublishManager.js')
  const nsis = read('../node_modules/electron-updater/out/NsisUpdater.js')
  it.skipIf(!schema || !packager || !publish)('electron-builder knows the option on win, and writes the name only while it is not false', () => {
    expect(JSON.parse(schema).definitions.WindowsConfiguration.properties.verifyUpdateCodeSignature.type).toBe('boolean')
    expect(packager).toMatch(/get isForceCodeSigningVerification\(\) \{\s*return this\.platformSpecificBuildOptions\.verifyUpdateCodeSignature !== false;/)
    expect(publish).toMatch(/const publisherName = winPackager\.isForceCodeSigningVerification \? [^:]+ : undefined;\s*if \(publisherName != null\) \{\s*publishConfig\.publisherName = publisherName;/)
  })
  it.skipIf(!nsis)('electron-updater checks no signature when the build carries no name', () => {
    expect(nsis).toMatch(/publisherName = \(await this\.configOnDisk\.value\)\.publisherName;\s*if \(publisherName == null\) \{\s*return null;/)
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
