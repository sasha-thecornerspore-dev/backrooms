// server/updater.js: only the release's bundled backrooms-server.js updates itself. `node server/index.js` from a checkout used to
// start the updater too: it compared the latest release with server/package.json (1.0.0, never bumped), downloaded the old bundle
// OVER the tracked server/index.js, respawned it detached and exited — and the respawn read the same 1.0.0 and did it again, in a
// loop (the 2.0.0 verify report, open issue 1). Now the updater runs only when the running file is named backrooms-server.js and
// carries the version esbuild stamped into it; it replaces that file in place, never index.js.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { ASSET_NAME, CHECK_INTERVAL, isBundledEntry, startUpdater } from '../server/updater.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('isBundledEntry: the running file is the release asset', () => {
  it('by its basename, on either separator', () => {
    expect(ASSET_NAME).toBe('backrooms-server.js')
    for (const e of ['/opt/backrooms/backrooms-server.js', 'C:\\games\\srv\\backrooms-server.js', 'backrooms-server.js', './backrooms-server.js']) {
      expect([e, isBundledEntry(e)]).toEqual([e, true])
    }
  })
  it('a checkout, a copy under another name, nothing at all: no', () => {
    for (const e of ['/repo/server/index.js', 'C:\\repo\\server\\index.js', '/x/backrooms-server.js.bak', '/x/backrooms-server.json', '/x/my-backrooms-server.js',
      '/x/backrooms-server.js/index.js', '', undefined, null, 42]) {
      expect([e, isBundledEntry(e)]).toEqual([e, false])
    }
  })
})

describe('startUpdater', () => {
  const rig = () => ({ check: vi.fn(), every: vi.fn() })
  it('from a checkout it does nothing: no check, no timer', () => {
    const r = rig()
    expect(startUpdater('2.0.0', 'o/r', { entry: '/repo/server/index.js', ...r })).toBe(false)
    expect(r.check).not.toHaveBeenCalled()
    expect(r.every).not.toHaveBeenCalled()
  })
  it('as the bundle without a stamped version (bundled by hand) it does nothing either', () => {
    for (const v of [null, undefined, '', 42]) {
      const r = rig()
      expect(startUpdater(v, 'o/r', { entry: '/srv/backrooms-server.js', ...r })).toBe(false)
      expect(r.check).not.toHaveBeenCalled()
    }
  })
  it('as the bundle with its version: checks now and every hour, for the running file', () => {
    const r = rig()
    expect(startUpdater('2.0.0', 'o/r', { entry: '/srv/backrooms-server.js', ...r })).toBe(true)
    expect(r.check).toHaveBeenCalledWith('2.0.0', 'o/r', '/srv/backrooms-server.js')
    expect(r.every).toHaveBeenCalledTimes(1)
    expect(r.every.mock.calls[0][1]).toBe(CHECK_INTERVAL)
    expect(CHECK_INTERVAL).toBe(60 * 60 * 1000)
    r.every.mock.calls[0][0]()
    expect(r.check).toHaveBeenCalledTimes(2)
  })
  it('defaults to process.argv[1], which under vitest is not the bundle', () => {
    expect(isBundledEntry(process.argv[1])).toBe(false)
  })
})

describe('the update replaces the running bundle in place, from the version stamped into it', () => {
  const updater = read('../server/updater.js')
  const index = read('../server/index.js')
  it('updater.js downloads beside the entry, renames onto it and respawns it with its own arguments — never index.js', () => {
    expect(updater).toContain("const tmp = entry + '.new'")
    expect(updater).toContain('renameSync(tmp, entry)')
    expect(updater).toContain('spawn(process.execPath, [entry, ...process.argv.slice(2)]')
    expect(updater).not.toMatch(/'index(\.new)?\.js'/)
  })
  it('index.js takes its version from the build, not from a package.json beside it', () => {
    expect(index).toContain("const SERVER_VERSION = typeof __BACKROOMS_VERSION__ === 'string' ? __BACKROOMS_VERSION__ : null")
    expect(index).toContain("startUpdater(SERVER_VERSION, 'sasha-thecornerspore-dev/backrooms')")
    expect(index).not.toContain("'package.json'")
    expect(index).not.toContain('readFileSync')
  })
  it('the release stamps the version into the bundle', () => {
    const yml = read('../.github/workflows/build-release.yml')
    expect(yml).toContain('VER=$(node -p "require(\'./package.json\').version")')
    expect(yml).toContain('npx esbuild server/index.js --bundle --platform=node --format=esm --outfile=dist/backrooms-server.js --external:ws --define:__BACKROOMS_VERSION__="\\"$VER\\""')
  })
})

describe('`node server/index.js` from a checkout, run for real', () => {
  it('listens and never reaches for a release', async () => {
    // a preload that turns every https request into a line on stdout (and refuses it): the updater's first move is an https.get
    const dir = mkdtempSync(path.join(tmpdir(), 'backrooms-updater-'))
    const pre = path.join(dir, 'no-https.mjs')
    writeFileSync(pre, [
      "import https from 'node:https'",
      "import { syncBuiltinESMExports } from 'node:module'",
      "const refuse = () => { process.stdout.write('UPDATER-REACHED-OUT\\n'); throw new Error('refused by the test') }",
      'https.get = refuse; https.request = refuse',
      'syncBuiltinESMExports()',
    ].join('\n'))
    const child = spawn(process.execPath, ['--import', pathToFileURL(pre).href, path.join(root, 'server', 'index.js')], {
      cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the server never said it was listening:\n' + out)), 8000)
        child.stdout.on('data', () => { if (out.includes('backrooms server on :')) { clearTimeout(t); resolve() } })
        child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited ${code}:\n${out}`)) })
      })
      await new Promise((r) => setTimeout(r, 400))
      expect(out).toContain('backrooms server on :')
      expect(out).not.toContain('UPDATER-REACHED-OUT')
      expect(out).not.toContain('[updater]')
      expect(child.exitCode).toBe(null)                // still running: it did not exit to respawn itself
    } finally {
      child.kill()
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }, 15000)
})
