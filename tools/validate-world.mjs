// validate-world.mjs — the "tested adaptation" gate for the wish pipeline.
//
// A granted wish rewrites src/renderer/world.json. Before that can ship to
// players, this asserts the file is structurally sound: it merges cleanly over
// DEFAULT_CONFIG (mirroring loadConfig) and every level still builds on top of
// it. Exits non-zero with a reason if anything is off. Run:  node tools/validate-world.mjs
// The rules are validateWorld(raw, { headRaw, wish }) so the tests run them in-process; headRaw
// is the shipped file (git HEAD), read only to refuse a drift that drops the docket and, on the
// wish path, one that touches the movement rate. The wish workflows run it with --wish (wish:
// true): a granted wish may not change `net` at all, while the owner's own edit is held only to
// its bounds. A checkout without git skips both HEAD rules.
import { readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig, levelCount } from '../src/renderer/levels.js'

const isHex = s => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)
const isNum = n => typeof n === 'number' && Number.isFinite(n)
const isObj = o => typeof o === 'object' && o !== null && !Array.isArray(o)
const sameKeys = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && keys.slice().sort().every((x, i) => x === k[i]) }
// the same JSON value whatever the order of its keys; an absent key (undefined) is the same only as another absent one
const sameJson = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  if (isObj(a) && isObj(b)) return sameKeys(a, Object.keys(b)) && Object.keys(a).every(k => sameJson(a[k], b[k]))
  return a === b
}
export const NET_WISH = "net changed: the movement rate is the owner's to set"

// four level rows ('0'..'3') of exactly three non-negative integer columns
function docketOk(d) {
  if (!isObj(d) || !sameKeys(d, ['0', '1', '2', '3'])) return false
  return Object.values(d).every(r => isObj(r) && sameKeys(r, ['extension', 'compliance', 'litigation']) &&
    Object.values(r).every(v => Number.isInteger(v) && v >= 0))
}

export function validateWorld(raw, { headRaw = null, wish = false } = {}) {
  const no = (reason) => ({ ok: false, reason })
  if (!isObj(raw)) return no('must be a JSON object')

  // merge the way the game does (loadConfig spreads world.json over DEFAULT_CONFIG)
  const cfg = { ...DEFAULT_CONFIG, ...raw }

  // only wish-editable keys are checked; missing keys fall back to DEFAULT_CONFIG and are fine
  if (raw.palette !== undefined) {
    const p = cfg.palette
    if (!p || !['wall', 'ceiling', 'floor', 'fog'].every(k => isHex(p[k]))) return no('palette needs wall/ceiling/floor/fog as #rrggbb hex')
  }
  if (raw.fogDistance !== undefined && !(isNum(cfg.fogDistance) && cfg.fogDistance > 0)) return no('fogDistance must be a positive number')
  if (raw.wallDensity !== undefined && !(isNum(cfg.wallDensity) && cfg.wallDensity > 0 && cfg.wallDensity < 1)) return no('wallDensity must be between 0 and 1')
  if (raw.flicker !== undefined && !(cfg.flicker && isNum(cfg.flicker.rate) && isNum(cfg.flicker.depth) && isNum(cfg.flicker.recoverySpeed))) return no('flicker needs numeric rate/depth/recoverySpeed')
  if (raw.messages !== undefined && !(Array.isArray(cfg.messages) && cfg.messages.length && cfg.messages.every(m => typeof m === 'string'))) return no('messages must be a non-empty array of strings')
  if (raw.items !== undefined && !(cfg.items && Array.isArray(cfg.items.types) && cfg.items.types.length)) return no('items.types must be a non-empty array')
  // the floor feelings' kill switch (feelings.js, read by levelConfig): a boolean, or absent (on)
  if (raw.feelings !== undefined && typeof raw.feelings !== 'boolean') return no('feelings must be true or false')
  // the movement send rate is the owner's: on the wish path any difference from HEAD's `net` (added, dropped or a field changed) is
  // refused, before its bounds are read, so a wish that moves it is told why
  if (wish && isObj(headRaw) && !sameJson(raw.net, headRaw.net)) return no(NET_WISH)
  // the movement send rate (game.js, client.js posHz): { posHz } and nothing else, an integer 5..20 a second, or absent (20)
  if (raw.net !== undefined && !(isObj(raw.net) && sameKeys(raw.net, ['posHz']) && Number.isInteger(raw.net.posHz) && raw.net.posHz >= 5 && raw.net.posHz <= 20)) {
    return no('net.posHz must be an integer from 5 to 20')
  }

  // the docket is recounted by tools/docket.mjs, never drifted: a bad shape or a dropped key fails
  if (raw.docket !== undefined && !docketOk(raw.docket)) return no('docket must be four level rows of three non-negative integers')
  if (raw.docket === undefined && isObj(headRaw) && headRaw.docket !== undefined) return no('docket was dropped (HEAD has one)')

  // every level must still build on the drifted base without throwing
  try {
    for (let i = 0; i < levelCount(); i++) {
      const c = levelConfig(cfg, i)
      if (!c.palette || !c.exit || typeof c.levelName !== 'string') return no('level ' + i + ' did not build cleanly')
    }
  } catch (e) { return no('a level failed to build over the drifted world — ' + e.message) }

  return { ok: true }
}

function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}

if (isMain()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const path = join(root, 'src', 'renderer', 'world.json')
  const fail = (msg) => { console.error('world.json REJECTED: ' + msg); process.exit(1) }

  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { fail('not valid JSON — ' + e.message) }

  // the shipped file; a checkout without git (a tarball) simply skips the HEAD rules (the docket's drop, the wish's net)
  let headRaw = null
  try {
    headRaw = JSON.parse(execFileSync('git', ['show', 'HEAD:src/renderer/world.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { headRaw = null }

  // --wish: the wish workflows' stricter check (a granted wish may not touch the movement rate); the owner's run has no flag
  const r = validateWorld(raw, { headRaw, wish: process.argv.slice(2).includes('--wish') })
  if (!r.ok) fail(r.reason)
  console.log('world.json OK — merges cleanly and all levels build.')
}
