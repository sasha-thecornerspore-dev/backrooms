import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import https from 'https'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { readSettings, writeSettings } from './settings.js'
import { fireBeacon } from './webhook.js'

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

// Build-time config (written by CI, gitignored)
let buildConfig = { wishToken: '', githubOwner: 'GITHUB_OWNER', githubRepo: 'backrooms' }
try {
  const raw = readFileSync(path.join(__dirname, 'build-config.json'), 'utf8')
  buildConfig = { ...buildConfig, ...JSON.parse(raw) }
} catch { /* dev mode: wish submission will fail gracefully */ }

// GitHub Issues API — creates a wish issue
ipcMain.handle('submit-wish', async (_event, text) => {
  if (!buildConfig.wishToken) return  // dev mode: silent no-op

  const appVersion = app.getVersion()
  const body = JSON.stringify({
    title: `[WISH] ${text.slice(0, 120)}`,
    body:  `${text}\n\n---\nsubmitted from backrooms v${appVersion}`,
    labels: ['wish', 'pending'],
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${buildConfig.githubOwner}/${buildConfig.githubRepo}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${buildConfig.wishToken}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     `backrooms/${appVersion}`,
        'Accept':         'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      res.resume()
      if (res.statusCode === 201) resolve()
      else reject(new Error(`GitHub API ${res.statusCode}`))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
})

let mainWindow = null
let lastBeaconAt = 0

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
  ipcMain.handle('save-settings', (_e, settings) => writeSettings(settingsPath, settings))
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
  // beacon (T0 solo): fire the player's OWN registered webhook. All validation
  // and the SSRF-safe POST live in webhook.js; here we only rate-limit + log.
  ipcMain.handle('fire-beacon', async (_e, payload) => {
    const { effect, webhook } = payload || {}
    const now = Date.now()
    if (now - lastBeaconAt < 10_000) return { ok: false, reason: 'cooldown' }
    lastBeaconAt = now
    try {
      const r = await fireBeacon(effect, webhook, { appVersion: app.getVersion(), now })
      logLine(`beacon: effect=${effect} ok=${r.ok} status=${r.status ?? '-'}${r.skipped ? ' (skipped)' : ''}`)
      return r
    } catch (e) {
      logLine(`beacon failed: ${e.message}`)
      return { ok: false, reason: e.message }
    }
  })
  ipcMain.handle('start-local-server', async () => {
    const { createServer } = await import('../server/index.js')
    const s = await createServer(0)
    return s.address().port
  })
  let updateDownloaded = false
  ipcMain.on('restart-now', () => { if (updateDownloaded) autoUpdater.quitAndInstall() })

  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true
    const settings = readSettings(settingsPath)
    if (settings.autoUpdate) {
      autoUpdater.quitAndInstall()
    } else {
      mainWindow?.webContents.send('update-ready')
    }
  })

  logLine(`backrooms v${app.getVersion()} starting (hardwareAccel=${hwAccel})`)

  // GPU process crashing/hanging is the prime suspect for full lockups
  app.on('child-process-gone', (_e, details) => {
    logLine(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })

  createWindowAndTrack()
  // Check for updates silently on launch (only runs in production builds)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify()
  }
})
app.on('window-all-closed', () => app.quit())
