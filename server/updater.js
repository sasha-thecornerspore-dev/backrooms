// server/updater.js
import { get } from 'https'
import { createWriteStream, renameSync, existsSync } from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSET_NAME = 'backrooms-server.js'
const CHECK_INTERVAL = 60 * 60 * 1000  // 1 hour

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'backrooms-server' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) return httpsGet(res.headers.location).then(resolve, reject)
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    }).on('error', reject)
  })
}

async function fetchLatestRelease(repoSlug) {
  const { body } = await httpsGet(`https://api.github.com/repos/${repoSlug}/releases/latest`)
  return JSON.parse(body)
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    get(url, { headers: { 'User-Agent': 'backrooms-server' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close()
        return downloadFile(res.headers.location, dest).then(resolve, reject)
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

function semverGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) > (pb[i]||0)) return true; if ((pa[i]||0) < (pb[i]||0)) return false }
  return false
}

async function checkAndUpdate(currentVersion, repoSlug) {
  try {
    const release = await fetchLatestRelease(repoSlug)
    const latest = release.tag_name
    if (!semverGt(latest, currentVersion)) return
    console.log(`[updater] newer version ${latest} available, downloading...`)
    const asset = release.assets.find(a => a.name === ASSET_NAME)
    if (!asset) return
    const tmp = join(__dirname, 'index.new.js')
    await downloadFile(asset.browser_download_url, tmp)
    renameSync(tmp, join(__dirname, 'index.js'))
    console.log('[updater] update applied, restarting...')
    const child = spawn(process.execPath, [join(__dirname, 'index.js')], {
      detached: true, stdio: 'ignore',
      env: { ...process.env }
    })
    child.unref()
    process.exit(0)
  } catch (e) {
    console.error('[updater] check failed:', e.message)
  }
}

export function startUpdater(currentVersion, repoSlug) {
  checkAndUpdate(currentVersion, repoSlug)
  setInterval(() => checkAndUpdate(currentVersion, repoSlug), CHECK_INTERVAL)
}
