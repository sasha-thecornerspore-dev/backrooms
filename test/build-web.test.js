// tools/build-play.sh and tools/build-itch.sh, run for real. The /play/ bundle carries world.json (a granted wish reaches the browser), the
// site's build carries the cookieless GoatCounter counter and no other build does (owner decision 2026-10-13: the landing page and /play/
// only, never the desktop app, never the itch zip), and the itch.io zip is flat, relative and counter-free (growth-spec §3).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const fwd = (p) => p.replace(/\\/g, '/')
const TAG = '<script data-goatcounter="https://backrooms.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'

// a bare `bash` on Windows is WSL's (system32): use Git's own bash, found beside git
function findBash() {
  if (process.platform !== 'win32') return spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null
  const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (ex.status !== 0) return null
  const gitRoot = path.resolve(ex.stdout.trim(), '..', '..', '..')
  return [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')].find((p) => fs.existsSync(p)) || null
}
const BASH = findBash()
// the build's own knobs never leak in from the shell that runs the suite
function run(script, args, env = {}) {
  const e = { ...process.env }
  for (const k of ['PLAY_TARGET', 'GOATCOUNTER_CODE', 'PLAY_SW_VERSION']) delete e[k]
  return spawnSync(BASH, [script, ...args.map(fwd)], { cwd: root, encoding: 'utf8', env: { ...e, ...env } })
}
const hasZipper = !!BASH && spawnSync(BASH, ['-c', "command -v zip >/dev/null || python3 -c 'import zipfile' 2>/dev/null || python -c 'import zipfile' 2>/dev/null"]).status === 0

// every file under dir (relative, forward slashes) with its text
function walk(dir, rel = '') {
  const out = []
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name
    if (d.isDirectory()) out.push(...walk(dir, r)); else out.push(r)
  }
  return out
}

// a zip's entries, read with nothing but zlib: the central directory names each entry and where its local header sits
function readZip(file) {
  const b = fs.readFileSync(file)
  let eocd = b.length - 22
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const count = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28)
    const elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42)
    const name = b.toString('utf8', p + 46, p + 46 + nlen)
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28)
    const raw = b.subarray(start, start + csize)
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nlen + elen + clen
  }
  return entries
}

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-build-web-')) })
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

describe.skipIf(!BASH)('tools/build-play.sh, run (the site build)', () => {
  let site
  beforeAll(() => {
    site = path.join(tmp, 'site')
    const r = run('tools/build-play.sh', ['src', site])
    expect(r.status, r.stderr).toBe(0)
  }, 120000)

  it('ships world.json byte-for-byte beside world.js, so a granted wish reaches /play/', () => {
    expect(fs.readFileSync(path.join(site, 'world.json'))).toEqual(fs.readFileSync(path.join(root, 'src', 'renderer', 'world.json')))
  })
  it('its service worker precaches world.json, fetches it network-first, and carries the default cache name', () => {
    const sw = fs.readFileSync(path.join(site, 'sw.js'), 'utf8')
    expect(sw).toContain(`'world.json'`)
    expect(sw).toContain("if (url.pathname.endsWith('/world.json')) {")
    expect(sw).toMatch(/const CACHE = 'backrooms-play-v\d+'/)
  })
  it('carries ONE counter, the owner\'s code, just before </head>, with the counted path fixed to /play/ (no query string is ever the path)', () => {
    const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
    expect(html.split(TAG).length - 1).toBe(1)
    expect(html.match(/data-goatcounter=/g)).toHaveLength(1)
    expect(html).toContain(`<script>window.goatcounter = { path: '/play/' }</script>`)
    expect(html.indexOf(`window.goatcounter = { path: '/play/' }`)).toBeLessThan(html.indexOf(TAG))   // the settings exist before count.js reads them
    expect(html.indexOf(TAG)).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf(TAG)).toBeGreaterThan(html.indexOf('<title>'))
  })
  it('the licenses travel with the bundle', () => {
    expect(fs.readFileSync(path.join(site, 'LICENSE'), 'utf8')).toContain('MIT License')
    expect(fs.readFileSync(path.join(site, 'LICENSE-LORE.md'), 'utf8')).toContain('CC BY-SA 3.0')
  })
})

describe.skipIf(!BASH)('tools/build-play.sh, run (the knobs)', () => {
  it('GOATCOUNTER_CODE names another counter', () => {
    const d = path.join(tmp, 'code')
    const r = run('tools/build-play.sh', ['src', d], { GOATCOUNTER_CODE: 'test' })
    expect(r.status, r.stderr).toBe(0)
    const html = fs.readFileSync(path.join(d, 'index.html'), 'utf8')
    expect(html).toContain('<script data-goatcounter="https://test.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>')
    expect(html).not.toContain('backrooms.goatcounter.com')
  }, 120000)
  it('a GOATCOUNTER_CODE that is not a plain code fails the build (it lands inside a URL in the page)', () => {
    for (const bad of ['a"b', 'x.evil.example/count?', 'UP']) {
      const r = run('tools/build-play.sh', ['src', path.join(tmp, 'bad')], { GOATCOUNTER_CODE: bad })
      expect(r.status, bad).not.toBe(0)
      expect(r.stderr).toContain('GOATCOUNTER_CODE')
    }
  }, 120000)
  it('PLAY_TARGET=itch builds the same bundle with no counter: no file anywhere carries the string goatcounter', () => {
    const d = path.join(tmp, 'itchdir')
    const r = run('tools/build-play.sh', ['src', d], { PLAY_TARGET: 'itch' })
    expect(r.status, r.stderr).toBe(0)
    const files = walk(d)
    expect(files).toContain('index.html'); expect(files).toContain('world.json')
    for (const f of files) expect(fs.readFileSync(path.join(d, f), 'utf8').toLowerCase(), f).not.toContain('goatcounter')
  }, 120000)
  it('PLAY_TARGET=itch registers no service worker: the registration is switched off and no sw.js is written (itch\'s origin is shared)', () => {
    const d = path.join(tmp, 'itchdir')
    expect(fs.existsSync(path.join(d, 'sw.js'))).toBe(false)
    const html = fs.readFileSync(path.join(d, 'index.html'), 'utf8')
    expect(html).toContain("if (false) {   // a portal build registers no service worker (tools/build-play.sh)")
    expect(html).not.toContain("if ('serviceWorker' in navigator && location.protocol.startsWith('http') && window.top === window.self) {")
    // the site build keeps its worker, registered relatively
    const site = fs.readFileSync(path.join(tmp, 'site', 'index.html'), 'utf8')
    expect(site).toContain("if ('serviceWorker' in navigator && location.protocol.startsWith('http') && window.top === window.self) {")
    expect(site).toContain("register('sw.js')")
  })
  it('an unknown PLAY_TARGET fails rather than guessing', () => {
    const r = run('tools/build-play.sh', ['src', path.join(tmp, 'unknown')], { PLAY_TARGET: 'steam' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('PLAY_TARGET')
  }, 120000)
})

describe.skipIf(!hasZipper)('tools/build-itch.sh, run (the itch.io HTML5 zip)', () => {
  let zip
  beforeAll(() => {
    const out = path.join(tmp, 'out', 'w.zip')
    const r = run('tools/build-itch.sh', ['src', out])
    expect(r.status, r.stderr).toBe(0)
    zip = readZip(out)
  }, 120000)

  it('index.html and every module sit at the root of the zip, flat', () => {
    for (const f of ['index.html', 'game.js', 'world.js', 'world.json', 'client.js', 'evbus.js', 'manifest.webmanifest', 'icons/icon-192.png', 'LICENSE', 'LICENSE-LORE.md']) {
      expect(zip.has(f), f).toBe(true)
    }
    expect(zip.get('world.json')).toEqual(fs.readFileSync(path.join(root, 'src', 'renderer', 'world.json')))
    expect(zip.has('sw.js')).toBe(false)
  })
  it('keeps inside itch\'s limits: at most 1000 entries, no path over 240 characters, no build config', () => {
    expect(zip.size).toBeLessThanOrEqual(1000)
    for (const n of zip.keys()) { expect(n.length).toBeLessThanOrEqual(240); expect(n.startsWith('/')).toBe(false); expect(n).not.toContain('..') }
    expect([...zip.keys()].some((n) => n.endsWith('build-config.json'))).toBe(false)
  })
  it('relative paths only: index.html holds no absolute src/href, imports its flat client, and registers no service worker', () => {
    const html = zip.get('index.html').toString('utf8')
    expect(html).not.toMatch(/(src|href)="\/[^/]/)
    expect(html).not.toContain('../net/')
    expect(html).toContain("'./client.js'")
    expect(html).toContain('if (false) {   // a portal build registers no service worker')
  })
  it('carries no counter: no entry contains the string goatcounter', () => {
    for (const [n, data] of zip) expect(data.toString('utf8').toLowerCase(), n).not.toContain('goatcounter')
  })
})

describe.skipIf(!hasZipper)('tools/build-itch.sh, its guards', () => {
  // a throwaway copy of src/ (renderer, net, icons) to plant things in
  const copySrc = (name) => {
    const s = path.join(tmp, name, 'src')
    for (const d of ['renderer', 'net', 'icons']) fs.cpSync(path.join(root, 'src', d), path.join(s, d), { recursive: true })
    return s
  }
  it('a build config with a token beside the source never reaches the zip', () => {
    const s = copySrc('planted')
    fs.writeFileSync(path.join(s, 'build-config.json'), '{"wishToken":"x"}')
    const out = path.join(tmp, 'planted', 'w.zip')
    const r = run('tools/build-itch.sh', [s, out])
    expect(r.status, r.stderr).toBe(0)
    for (const [n, data] of readZip(out)) expect(data.toString('utf8'), n).not.toContain('wishToken')
  }, 120000)
  it('a counter that slipped into the bundle by any road fails the build, and no zip is written', () => {
    const s = copySrc('slipped')
    fs.appendFileSync(path.join(s, 'renderer', 'prefs.js'), '\n// window.goatcounter\n')
    const out = path.join(tmp, 'slipped', 'w.zip')
    const r = run('tools/build-itch.sh', [s, out])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('goatcounter')
    expect(fs.existsSync(out)).toBe(false)
  }, 120000)
})

describe('tools/build-itch.sh (source)', () => {
  const src = fs.readFileSync(path.join(root, 'tools', 'build-itch.sh'), 'utf8')
  it('builds through build-play.sh with the itch target, so the counter is never injected', () => {
    expect(src).toMatch(/PLAY_TARGET=itch [^\n]*bash "\$\(dirname "\$0"\)\/build-play\.sh" "\$SRC" "\$P"/)
  })
  it('checks the bundle before it zips it', () => {
    const zipAt = src.indexOf('zip -q -r -X')
    for (const guard of ['grep -rli goatcounter', 'build-config.json', 'wishToken|ghp_|github_pat_', '(src|href)="/[^/]', '-le 1000']) {
      expect(src.indexOf(guard), guard).toBeGreaterThan(-1)
      expect(src.indexOf(guard), guard).toBeLessThan(zipAt)
    }
  })
})
