import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { readSettings, writeSettings } from './settings.js'
import { createUpdateController, RELEASES_URL } from './updater.js'
import { fireBeacon } from './webhook.js'
import { postWish } from './renderer/wish-post.js'
import { createLanHost, lanUrl, LAN_ROOM } from './lan.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── diagnostics log (userData/backrooms.log) ──
function logPath() { try { return path.join(app.getPath('userData'), 'backrooms.log') } catch { return null } }
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { const p = logPath(); if (p) appendFileSync(p, line) } catch { /* ignore */ }
  console.log(msg)
}
process.on('uncaughtException', (e) => logLine(`main uncaughtException: ${e?.stack || e}`))
process.on('unhandledRejection', (e) => logLine(`main unhandledRejection: ${e?.stack || e}`))

// ── GPU-hang escape hatch: if the user enabled software rendering (because
// their GPU driver hard-locks the app), disable hardware acceleration. Must be
// decided BEFORE app is ready, so read settings.json synchronously here. ──
let hwAccel = true
try {
  const sp = path.join(app.getPath('userData'), 'settings.json')
  const s = JSON.parse(readFileSync(sp, 'utf8'))
  if (s.softwareRender) { app.disableHardwareAcceleration(); hwAccel = false; logLine('software rendering ON — hardware acceleration disabled') }
} catch { /* no settings yet, or userData not ready: default to hardware accel */ }

// A wish goes to the relay's /wish (renderer/wish-post.js), which files the issue with the only key there is —
// relay/wishgate.js builds the title (first line), the labels (the trailer in `text`, `meta` { origin }) and
// the body, as this handler once did. The app carries no token. A dev run (`electron .`, not packaged) sends
// nothing, as it never did.
ipcMain.handle('submit-wish', async (_event, text, meta) => {
  if (!app.isPackaged) return  // dev mode: silent no-op
  return postWish(text, meta, { version: app.getVersion() })
})

let mainWindow = null
let lastBeaconAt = 0
let lanHost = null   // the one HOST LAN server for this app run (see lan.js)

function createWindowAndTrack() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreenable: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // ── hang / crash recovery: turn a hard lockup into an auto-reload, and log
  // why it happened so a real GPU/renderer hang leaves evidence behind. ──
  let unresponsiveTimer = null
  mainWindow.on('unresponsive', () => {
    logLine('renderer UNRESPONSIVE')
    if (unresponsiveTimer) return
    // give it a chance to recover on its own; if it doesn't, reload the world
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      if (!mainWindow || mainWindow.isDestroyed()) return
      logLine('renderer still hung after 8s — crashing + reloading it')
      // crashing the renderer fires 'render-process-gone' below, which reloads
      try { mainWindow.webContents.forcefullyCrashRenderer() } catch { try { mainWindow.reload() } catch { /* ignore */ } }
    }, 8000)
  })
  mainWindow.on('responsive', () => {
    logLine('renderer responsive again')
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null }
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logLine(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
    if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.reload() } catch { /* ignore */ } }
  })
}

app.whenReady().then(() => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json')

  ipcMain.handle('get-settings', () => readSettings(settingsPath))
  ipcMain.handle('save-settings', (_e, settings) => {
    writeSettings(settingsPath, settings)
    updates.applyMode()   // switching to/from 'manual' starts or stops the background checks
  })
  ipcMain.handle('get-version', () => app.getVersion())

  // renderer diagnostics — surface renderer-side errors/stalls into the log file
  // so a freeze that never trips 'unresponsive' still leaves a cause behind.
  ipcMain.on('renderer-log', (_e, msg) => logLine(`renderer: ${String(msg).slice(0, 800)}`))

  // polaroid — the renderer hands over a PNG data URL, we file the evidence
  ipcMain.handle('save-photo', (_e, dataUrl) => {
    const PREFIX = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) return null
    try {
      const dir = path.join(app.getPath('pictures'), 'backrooms')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `evidence-${Date.now()}.png`)
      writeFileSync(file, Buffer.from(dataUrl.slice(PREFIX.length), 'base64'))
      return file
    } catch {
      return null
    }
  })

  // "locate your body" — only Google Maps ever gets opened
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://www.google.com/maps')) {
      shell.openExternal(url)
      return true
    }
    return false
  })
  // an invite (index.html shareInvite, the console's /invite): only ever our own /play/ address, never arbitrary text from the page
  // Electron 44's clipboard follows the W3C Clipboard API: writeText returns a promise, so the answer waits for it — a refused
  // write says false, and the page shows the link to copy by hand
  ipcMain.handle('copy-invite', async (_e, url) => {
    if (typeof url === 'string' && url.length <= 300 && url.startsWith('https://backrooms.thecornerspore.dev/play/?room=')) {
      try { await clipboard.writeText(url); return true } catch { return false }
    }
    return false
  })
  // beacon (T0 solo): fire the player's OWN registered webhook. All validation
  // and the SSRF-safe POST live in webhook.js; here we only rate-limit + log.
  ipcMain.handle('fire-beacon', async (_e, payload) => {
    const { effect, webhook, anchor } = payload || {}
    const now = Date.now()
    if (now - lastBeaconAt < 10_000) return { ok: false, reason: 'cooldown' }
    lastBeaconAt = now
    try {
      const r = await fireBeacon(effect, webhook, { appVersion: app.getVersion(), now, anchor })   // the pin: custom body only
      logLine(`beacon: effect=${effect} ok=${r.ok} status=${r.status ?? '-'}${r.skipped ? ' (skipped)' : ''}`)
      return r
    } catch (e) {
      // node network errors embed the target host in .message; prefer the error code which is safe to log to disk
      logLine(`beacon failed: ${e.code || e.message}`)
      return { ok: false, reason: e.code || e.message }
    }
  })
  // HOST LAN: one server per app run on port 8765 (a free port only if 8765 is taken), in the
  // room JOIN LAN defaults to. The renderer shows the returned url + room so a friend can join.
  ipcMain.handle('start-local-server', async () => {
    if (!lanHost) {
      const { createServer } = await import('../server/index.js')
      if (!lanHost) lanHost = createLanHost({ createServer })
    }
    const port = await lanHost.start()
    logLine(`lan host listening on port ${port}`)
    return { port, url: lanUrl(os.networkInterfaces(), port), room: LAN_ROOM }
  })
  // updates: auto / notify / manual (see updater.js); the renderer shows the status and drives check/download/restart
  const updates = createUpdateController({
    autoUpdater,
    getMode: () => readSettings(settingsPath).updateMode,
    send: (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status) },
    log: logLine,
    openReleases: () => shell.openExternal(RELEASES_URL),
    enabled: app.isPackaged,   // dev builds have no app-update.yml to check against
  })
  ipcMain.handle('update-status', () => updates.getStatus())
  ipcMain.handle('update-check', () => updates.check())
  ipcMain.handle('update-download', () => updates.download())
  ipcMain.on('restart-now', () => updates.restart())

  logLine(`backrooms v${app.getVersion()} starting (hardwareAccel=${hwAccel})`)

  // GPU process crashing/hanging is the prime suspect for full lockups
  app.on('child-process-gone', (_e, details) => {
    logLine(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })

  createWindowAndTrack()
  updates.start()   // checks on launch unless the player chose 'manual'
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (lanHost) lanHost.close().catch(() => {}) })
