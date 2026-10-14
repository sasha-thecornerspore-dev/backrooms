// server/updater.js — the standalone server keeps itself current from the latest release.
//
// Only the release's own bundle does: the file running must be named backrooms-server.js (the release asset) and carry the
// version esbuild stamped into it (index.js SERVER_VERSION). `node server/index.js` from a checkout never updates — it used
// to download the bundle OVER the tracked server/index.js, respawn and exit, and the respawn read server/package.json's
// never-bumped 1.0.0 and did it again, in a loop (the 2.0.0 verify report). The update replaces the running file in place
// and respawns it with the same arguments, so the new copy is still the bundle and still knows its version.
import { get } from 'https'
import { createWriteStream, renameSync } from 'fs'
import { spawn } from 'child_process'

export const ASSET_NAME = 'backrooms-server.js'
export const CHECK_INTERVAL = 60 * 60 * 1000  // 1 hour

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

// the running file is the release asset: by its basename, whichever separator the path uses
export function isBundledEntry(entry) {
  return typeof entry === 'string' && entry.split(/[\\/]/).pop() === ASSET_NAME
}

async function checkAndUpdate(currentVersion, repoSlug, entry) {
  try {
    const release = await fetchLatestRelease(repoSlug)
    const latest = release.tag_name
    if (!semverGt(latest, currentVersion)) return
    console.log(`[updater] newer version ${latest} available, downloading...`)
    const asset = release.assets.find(a => a.name === ASSET_NAME)
    if (!asset) return
    const tmp = entry + '.new'
    await downloadFile(asset.browser_download_url, tmp)
    renameSync(tmp, entry)
    console.log('[updater] update applied, restarting...')
    const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
      detached: true, stdio: 'ignore',
      env: { ...process.env }
    })
    child.unref()
    process.exit(0)
  } catch (e) {
    console.error('[updater] check failed:', e.message)
  }
}

// → true when it started (the bundle, with its stamped version); false, and nothing at all happens, otherwise
export function startUpdater(currentVersion, repoSlug, { entry = process.argv[1], check = checkAndUpdate, every = setInterval } = {}) {
  if (!isBundledEntry(entry) || typeof currentVersion !== 'string' || !currentVersion) return false
  check(currentVersion, repoSlug, entry)
  every(() => check(currentVersion, repoSlug, entry), CHECK_INTERVAL)
  return true
}
