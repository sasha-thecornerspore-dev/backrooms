// server/updater.js — the standalone server keeps itself current from the latest release.
//
// Only the release's own bundle does: the file running must be named backrooms-server.js (the release asset) and carry the
// version esbuild stamped into it (index.js SERVER_VERSION). `node server/index.js` from a checkout never updates — it used
// to download the bundle OVER the tracked server/index.js, respawn and exit, and the respawn read server/package.json's
// never-bumped 1.0.0 and did it again, in a loop (the 2.0.0 verify report). The update replaces the running file in place
// and respawns it with the same arguments, so the new copy is still the bundle and still knows its version.
import { get } from 'https'
import { createWriteStream, renameSync, statSync, unlinkSync, readFileSync } from 'fs'
import { spawn, spawnSync } from 'child_process'

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

// The asset, written to dest only from a 200: a 403 / 404 / 5xx page is never written as if it were the server, a write or read that
// fails rejects, and a body cut short rejects (checkAndUpdate also holds the file to the release's size before it is used)
const REDIRECTS = new Set([301, 302, 303, 307, 308])
export function downloadFile(url, dest, { get: g = get, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'))
    const req = g(url, { headers: { 'User-Agent': 'backrooms-server' } }, (res) => {
      if (REDIRECTS.has(res.statusCode) && res.headers.location) {
        res.resume()
        return downloadFile(new URL(res.headers.location, url).href, dest, { get: g, hops: hops + 1 }).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`the download answered ${res.statusCode}`)) }
      const file = createWriteStream(dest)
      let failed = false
      const fail = (e) => { if (failed) return; failed = true; res.unpipe(file); file.destroy(); reject(e) }
      file.on('error', fail)
      res.on('error', fail)
      res.on('aborted', () => fail(new Error('the download was cut short')))
      res.on('close', () => { if (!res.complete) fail(new Error('the download was cut short')) })
      file.on('finish', () => file.close((e) => (failed ? null : e ? fail(e) : resolve())))
      res.pipe(file)
    })
    req.on('error', reject)
  })
}

// the bundle is an ES module: parse it (never run it) the way it will be loaded
export function parsesAsModule(file) {
  try { return spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file), stdio: ['pipe', 'ignore', 'ignore'] }).status === 0 } catch { return false }
}

function respawnAndExit(entry) {
  console.log('[updater] update applied, restarting...')
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    detached: true, stdio: 'ignore',
    env: { ...process.env }
  })
  child.unref()
  process.exit(0)
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

// The running file is replaced only by a download that is whole (the release's own byte count) and parses: anything else is deleted
// and the server keeps running as it was — a respawned file that dies on a SyntaxError, detached with nothing watching, is a server gone
export async function checkAndUpdate(currentVersion, repoSlug, entry, { fetchRelease = fetchLatestRelease, download = downloadFile, parses = parsesAsModule, restart = respawnAndExit } = {}) {
  let tmp = null
  try {
    const release = await fetchRelease(repoSlug)
    const latest = release.tag_name
    if (!semverGt(latest, currentVersion)) return false
    console.log(`[updater] newer version ${latest} available, downloading...`)
    const asset = (release.assets || []).find(a => a.name === ASSET_NAME)
    if (!asset) return false
    tmp = entry + '.new'
    await download(asset.browser_download_url, tmp)
    const size = statSync(tmp).size
    if (!(Number.isInteger(asset.size) && asset.size > 0 && size === asset.size)) throw new Error(`downloaded ${size} bytes; the release says ${asset.size}`)
    if (!parses(tmp)) throw new Error('the download does not parse as the server')
    renameSync(tmp, entry)
    tmp = null
    restart(entry)
    return true
  } catch (e) {
    console.error('[updater] check failed:', e.message)
    return false
  } finally {
    if (tmp) { try { unlinkSync(tmp) } catch { /* never written */ } }
  }
}

// → true when it started (the bundle, with its stamped version); false, and nothing at all happens, otherwise
export function startUpdater(currentVersion, repoSlug, { entry = process.argv[1], check = checkAndUpdate, every = setInterval } = {}) {
  if (!isBundledEntry(entry) || typeof currentVersion !== 'string' || !currentVersion) return false
  check(currentVersion, repoSlug, entry)
  every(() => check(currentVersion, repoSlug, entry), CHECK_INTERVAL)
  return true
}
