import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import path from 'path'
import { join } from 'path'
import { readFileSync } from 'fs'
import https from 'https'
import { autoUpdater } from 'electron-updater'
import { readSettings, writeSettings } from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

function createWindowAndTrack() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreenable: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  const settingsPath = join(app.getPath('userData'), 'settings.json')

  ipcMain.handle('get-settings', () => readSettings(settingsPath))
  ipcMain.handle('save-settings', (_e, settings) => writeSettings(settingsPath, settings))
  ipcMain.handle('start-local-server', async () => {
    const { createServer } = await import('../server/index.js')
    const s = await createServer(0)
    return s.address().port
  })
  ipcMain.on('restart-now', () => autoUpdater.quitAndInstall())

  autoUpdater.on('update-downloaded', () => {
    const settings = readSettings(settingsPath)
    if (settings.autoUpdate) {
      autoUpdater.quitAndInstall()
    } else {
      mainWindow?.webContents.send('update-ready')
    }
  })

  createWindowAndTrack()
  // Check for updates silently on launch (only runs in production builds)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify()
  }
})
app.on('window-all-closed', () => app.quit())
