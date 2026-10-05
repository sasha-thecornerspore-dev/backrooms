// Update controller — wraps electron-updater's autoUpdater behind the player's chosen mode:
//   auto   : check on launch and every few hours, download quietly, install when the app quits
//            (a "restart now" prompt appears as soon as it is ready, for anyone who wants it sooner)
//   notify : check on launch and every few hours, but only DOWNLOAD when the player says so
//   manual : never check on its own — only the "check for updates" button does anything
// The renderer is told every state change as { state, version?, percent?, error?, manual? }.
//
// macOS builds are unsigned, and Squirrel.Mac refuses to install an unsigned update. There we still
// check (latest-mac.yml) so the player hears about a new version, but "download" opens the release
// page instead of downloading in-app.

export const UPDATE_MODES = ['auto', 'notify', 'manual']
export const RECHECK_MS = 4 * 60 * 60 * 1000
export const RELEASES_URL = 'https://github.com/sasha-thecornerspore-dev/backrooms/releases/latest'

export function normalizeMode(mode) {
  return UPDATE_MODES.includes(mode) ? mode : 'auto'
}

export function createUpdateController({
  autoUpdater,
  getMode,            // () => current mode string (read fresh from settings each time)
  send,               // (status) => void — forwards to the renderer
  log,                // (line) => void
  openReleases,       // () => void — opens RELEASES_URL in the browser
  platform = process.platform,
  enabled = true,     // false in dev (unpackaged) builds: no app-update.yml to check against
  setInterval: every = setInterval,
  clearInterval: stop = clearInterval,
}) {
  const canInstall = platform !== 'darwin'
  let status = { state: enabled ? 'idle' : 'unsupported' }
  let timer = null

  const emit = (next) => { status = next; try { send(status) } catch { /* window gone */ } }
  // an offline launch, a rate limit or a missing app-update.yml is not a crash: log the code only
  // (network error messages can embed hosts) and never let it reach the unhandledRejection handler
  const failed = (e) => {
    const code = e?.code || e?.message || String(e)
    log(`update check failed: ${code}`)
    emit({ state: 'error', error: e?.code || 'could not reach the update server' })
  }

  autoUpdater.autoInstallOnAppQuit = canInstall
  autoUpdater.on('error', failed)
  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => { log('update check: up to date'); emit({ state: 'up-to-date' }) })
  autoUpdater.on('update-available', (info) => {
    const version = info?.version
    log(`update available: v${version}`)
    // in auto mode the download has already started on its own; otherwise wait for the player
    if (canInstall && autoUpdater.autoDownload) emit({ state: 'downloading', version, percent: 0 })
    else emit({ state: 'available', version, manual: !canInstall })
  })
  autoUpdater.on('download-progress', (p) => {
    emit({ state: 'downloading', version: status.version, percent: Math.round(p?.percent || 0) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`update downloaded: v${info?.version}`)
    emit({ state: 'downloaded', version: info?.version })
  })

  function check() {
    if (!enabled) return Promise.resolve(status)
    // mid-download or already downloaded: a fresh check would only reset what the player sees
    if (status.state === 'downloading' || status.state === 'downloaded') return Promise.resolve(status)
    autoUpdater.autoDownload = canInstall && normalizeMode(getMode()) === 'auto'
    return Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .then(() => status, (e) => { failed(e); return status })
  }

  function download() {
    if (status.state !== 'available') return Promise.resolve(status)
    if (!canInstall) { openReleases(); return Promise.resolve(status) }
    emit({ state: 'downloading', version: status.version, percent: 0 })
    return Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .then(() => status, (e) => { failed(e); return status })
  }

  function restart() {
    if (status.state === 'downloaded') autoUpdater.quitAndInstall()
  }

  // (re)arm the background schedule for the current mode; called at launch and on every settings save
  function applyMode() {
    if (timer) { stop(timer); timer = null }
    if (!enabled) return
    const mode = normalizeMode(getMode())
    if (mode === 'manual') return
    timer = every(() => { check() }, RECHECK_MS)
    timer?.unref?.()
  }

  function start() {
    applyMode()
    if (enabled && normalizeMode(getMode()) !== 'manual') check()
  }

  return { start, check, download, restart, applyMode, getStatus: () => status, canInstall }
}
