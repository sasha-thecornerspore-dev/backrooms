import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import https from 'https'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Build-time config (written by CI, gitignored)
let buildConfig = { wishToken: '', githubOwner: 'GITHUB_OWNER', githubRepo: 'backrooms' }
try {
  const raw = readFileSync(path.join(__dirname, 'build-config.json'), 'utf8')
  buildConfig = { ...buildConfig, ...JSON.parse(raw) }
} catch { /* dev mode: wish submission will fail gracefully */ }

function createWindow() {
  const win = new BrowserWindow({
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// GitHub Issues API — creates a wish issue
ipcMain.handle('submit-wish', async (_event, text) => {
  if (!buildConfig.wishToken) return  // dev mode: silent no-op

  const appVersion = app.getVersion()
  const body = JSON.stringify({
    title: `[WISH] ${text.slice(0, 120)}`,
    body:  `submitted from backrooms v${appVersion}`,
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

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
