// lib.mjs — load ONE renderer tree (--src, default this repo's src/renderer) and build a floor exactly the way that tree's game.js
// buildLevel does, from its own shipped modules, read-only. The same tools then measure any tree: 2.0.3, 2.0.4, a fixed tree.
//
//   const T = await loadTree(src)   T.W, T.LV, T.ENT, ... the tree's modules; T.has the wiring its game.js actually carries (sniffed
//                                   from the source, so a module that exists but is not wired does not count); T.buildFloor(...)
//
// Order (game.js buildLevel): cache -> grid -> bodies -> decor (passes: stairs, dress, haunts, the first run's note) -> solid ->
// entitySys -> items.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_SRC = path.join(REPO, 'src', 'renderer')

// --key value pairs and bare --flags; `valued` names the keys that take a value
export function parseArgs(argv, valued = []) {
  const val = {}, flags = new Set(), want = new Set(valued)
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const k = t.slice(2)
    if (want.has(k)) val[k] = argv[++i]
    else flags.add(k)
  }
  return { val, flags }
}

// what this tree's game.js wires: each a plain source test, so the walker follows the game and not merely the modules on disk
export const WIRING = Object.freeze({
  pull: /pullVisible\(pullAsk\)/,                          // T1-2 the faint pull waits (PULL_WAIT_S / 120 s fresh), no metres, wobbles
  nearestWayOn: /\.nearestWayOn\(/,                         // T1-2 the faint pull never names a stair up
  plates: /createPlateBudget\(\)/,                          // T1-4 the plate budget
  floorPlate: /plate\('floor', arrivalPlate\(/,             // T1-4 the floor's own line, first visit its sub-line
  lostLine: /lostDue\(compassOut/,                          // T1-2 'there is no exit. keep looking.' out of the murmur draw
  hintHold: /hintHeld = true/,                              // T1-2 the fresh lobby holds its exit hint until the pull frees
  murmurBag: /murmurBag\.next\(\)/,                         // T1-5 murmurs from a bag
  eventArrive: /eventSched\.arrive\(/,                      // T1-5 the arrival event
  soundOnly: /eventSched\.soundOnly/,                       // T1-5 the arrival event is heard, not read
  fxEvents: /eventFx\(id/,                                  // T1-5 data events
  seenLine: /seenLine\(onScreen\)/,                         // T1-6 seen on screen, or heard
  dread: /dreadFrom\(ents/,                                 // T1-8 dread, the teller, tension's fourth argument
  lightOnce: /lightSaid = true/,                            // T1-4 the flashlight's lines once a run
  smilerOnce: /smilerTold = true/,                          // T1-4 the smiler's teaching line once a run
  firstRun: /createFirstRun\(/,                             // T1-3 the first run's thread
  entitySeed: /now: \(\) => playT, seed: worldSeed/,        // T1-11 the world seed moves the creatures
  searchHold: /searchLog\.hold\(/,                          // T1-9 a full-handed roll is held
  lostWait: /lostDue\(compassOut, lostSaid, pullAsk\.floorT/, // review W2: the setting's line waits LOST_AFTER_S into a visit, none after a lead
  ambientIdle: /PRIO\.ambient && !msgQ\.idle\(\)/,          // review W4: an ambient line the queue would drop is no plate and no count
})

export async function loadTree(src = DEFAULT_SRC) {
  const dir = path.resolve(src)
  if (!existsSync(path.join(dir, 'game.js'))) throw new Error(`loadTree: no game.js in ${dir} (give --src <tree>/src/renderer)`)
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href)
  const opt = (f) => (existsSync(path.join(dir, f)) ? imp(f) : Promise.resolve(null))
  const T = {
    dir,
    W: await imp('world.js'), LV: await imp('levels.js'), ENT: await imp('entities.js'), DEC: await imp('decor.js'),
    COL: await imp('collide.js'), ITM: await imp('items.js'), TOP: await imp('topology.js'), DRS: await imp('dress.js'),
    HNT: await imp('haunts.js'), EVT: await imp('events.js'), HUNT: await imp('hunt.js'), TEN: await imp('tension.js'),
    MSG: await imp('messages.js'), SAN: await imp('compose-sanity.js'), RUL: await imp('origin-rules.js'), STA: await imp('status.js'),
    CLO: await imp('closings.js'), CON: await imp('containers.js'), RAY: await imp('raycaster.js'), FRM: await imp('gfx-frame.js'),
    SPR: await imp('sightpins.js'), GQ: await imp('gfx-quality.js'), VAR: await imp('variants.js'), WARD: await imp('ward.js'),
    CMP: await imp('compass.js'), LSH: await opt('lightshare.js'),
    // 2.0.4 and later (null on 2.0.3)
    PLT: await opt('plates.js'), FR: await opt('firstrun.js'), DRD: await opt('dread.js'), PF: await opt('pathfield.js'),
  }
  const game = readFileSync(path.join(dir, 'game.js'), 'utf8')
  T.has = Object.fromEntries(Object.entries(WIRING).map(([k, re]) => [k, re.test(game)]))
  // a wiring test only counts when its module is there too
  if (!T.PLT) T.has.plates = T.has.floorPlate = false
  if (!T.FR) T.has.firstRun = T.has.hintHold = false
  if (!T.DRD || !T.PF) T.has.dread = false
  if (!T.CMP.pullVisible) T.has.pull = false
  if (!T.CMP.LOST_AFTER_S) T.has.lostWait = false
  if (typeof T.MSG.createMessageQueue().idle !== 'function') T.has.ambientIdle = false
  T.CHUNK = T.W.CHUNK_SIZE
  T.version = (() => { try { return JSON.parse(readFileSync(path.join(dir, '..', '..', 'package.json'), 'utf8')).version } catch { return '?' } })()

  // game.js: 1 in 12 chunks has a presence at its midpoint
  T.chunkHasPresence = (cx, cy) => {
    let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) & 0xFF) % 12 === 0
  }

  // buildFloor(index, worldSeed, spawnChunk, { clock, mutate, fresh }) -> the same subsystem graph that tree's game.js builds.
  // fresh: a fresh run's lobby (worldSeed null, the first-run thread on): the first run's note joins the passes, as game.js does
  T.buildFloor = (index, worldSeed = null, spawnChunk = { cx: 0, cy: 0 }, { clock = () => 0, mutate = null, fresh = false } = {}) => {
    const cfg = T.LV.levelConfig(T.W.DEFAULT_CONFIG, index)
    cfg.ways = T.TOP.waysFor(index)
    if (mutate) mutate(cfg)
    const cache = T.W.createChunkCache(cfg, worldSeed)
    cache.preload(spawnChunk.cx, spawnChunk.cy)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const grid = T.W.createGridReader(cache, isWall)
    grid.setPlayerChunk(spawnChunk.cx, spawnChunk.cy)
    const bodies = T.COL.createColliderIndex()
    let notePass = null
    if (fresh && index === 0 && T.has.firstRun) {
      const nc = `${Math.floor(T.FR.FIRST_NOTE.x / T.CHUNK)},${Math.floor(T.FR.FIRST_NOTE.y / T.CHUNK)}`
      notePass = (ctx) => { if (ctx.key === nc) ctx.add('scrap', T.FR.noteRecord()) }
    }
    const decor = T.DEC.createDecorSystem(cfg, isWall, worldSeed, {
      passes: [T.TOP.stairsPass(cfg, cfg.ways), T.DRS.dressPass(cfg), T.HNT.hauntsPass(cfg), notePass].filter(Boolean),
      onChunk: (k, b) => bodies.setChunk(k, b.colliders),
      onEvict: (k) => bodies.dropChunk(k),
    })
    const solid = T.COL.createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature: T.HUNT.solidCreature })
    const entitySys = T.ENT.createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: clock, ...(T.has.entitySeed ? { seed: worldSeed } : {}) })
    const itemSys = T.ITM.createItemSystem(cfg, isWall, worldSeed)
    itemSys.enterLevel(cfg, null, null)
    decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)
    const mid = T.TOP.chunkMid(spawnChunk.cx, spawnChunk.cy)
    const spawn = T.TOP.findOpenNear(mid.x, mid.y, grid.floor) ?? mid
    return { index, cfg, cache, isWall, grid, bodies, decor, solid, entitySys, itemSys, spawn, seed: worldSeed }
  }

  // the floor a run arrives on by the parent's exit (topology.arrivalFor: beside the partner stair when there is one, else the
  // from-chunk's mid) -> { floor, at, partner }
  T.arrivalFrom = (index, worldSeed, exitRec) => {
    const fcx = Math.floor(exitRec.x / T.CHUNK), fcy = Math.floor(exitRec.y / T.CHUNK)
    const f = T.buildFloor(index, worldSeed, { cx: fcx, cy: fcy })
    const partner = f.decor.wayAt(fcx, fcy, 'up')
    const a = T.TOP.arrivalFor({ way: { kind: 'down' }, fromCx: fcx, fromCy: fcy, partner, floorFn: f.grid.floor })
    return { floor: f, at: { x: a.x, y: a.y }, partner: !!partner }
  }

  T.bfs = (grid, sx, sy, ccx, ccy, R = 3) => bfs(T.CHUNK, grid, sx, sy, ccx, ccy, R)
  return T
}

// BFS over the grid reader from (sx, sy) within a Chebyshev chunk window around (ccx, ccy). Returns { dist, ox, oy, Wd, at(x, y) }.
export function bfs(CHUNK, grid, sx, sy, ccx, ccy, R = 3) {
  const ox = (ccx - R) * CHUNK, oy = (ccy - R) * CHUNK, Wd = (2 * R + 1) * CHUNK
  const dist = new Int32Array(Wd * Wd).fill(-1)
  const q = new Int32Array(Wd * Wd)
  const s = (Math.floor(sy) - oy) * Wd + (Math.floor(sx) - ox)
  let h = 0, t = 0
  dist[s] = 0; q[t++] = s
  while (h < t) {
    const i = q[h++]
    const lx = i % Wd, ly = (i - lx) / Wd
    const d = dist[i] + 1
    if (lx > 0) { const j = i - 1; if (dist[j] < 0 && grid.floor(ox + lx - 1, oy + ly)) { dist[j] = d; q[t++] = j } }
    if (lx < Wd - 1) { const j = i + 1; if (dist[j] < 0 && grid.floor(ox + lx + 1, oy + ly)) { dist[j] = d; q[t++] = j } }
    if (ly > 0) { const j = i - Wd; if (dist[j] < 0 && grid.floor(ox + lx, oy + ly - 1)) { dist[j] = d; q[t++] = j } }
    if (ly < Wd - 1) { const j = i + Wd; if (dist[j] < 0 && grid.floor(ox + lx, oy + ly + 1)) { dist[j] = d; q[t++] = j } }
  }
  return { dist, ox, oy, Wd, at: (x, y) => { const lx = Math.floor(x) - ox, ly = Math.floor(y) - oy; return (lx < 0 || ly < 0 || lx >= Wd || ly >= Wd) ? -1 : dist[ly * Wd + lx] } }
}

// a path of cells from the BFS field back to its source (the field is built FROM the source; walk downhill from the target)
export function pathTo(field, grid, tx, ty) {
  let x = Math.floor(tx), y = Math.floor(ty)
  let d = field.at(x + 0.5, y + 0.5)
  if (d < 0) return null
  const out = [[x, y]]
  while (d > 0) {
    let moved = false
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nd = field.at(x + dx + 0.5, y + dy + 0.5)
      if (nd === d - 1) { x += dx; y += dy; d = nd; out.push([x, y]); moved = true; break }
    }
    if (!moved) break
  }
  return out.reverse()
}

export function mulberry(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── statistics ──
export const pct = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1)))); return a[i] }
export const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN
export const r1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : v
export const r2 = (v) => Number.isFinite(v) ? Math.round(v * 100) / 100 : v
export function dist(arr) { return { n: arr.length, mean: r1(mean(arr)), p10: r1(pct(arr, 10)), p50: r1(pct(arr, 50)), p90: r1(pct(arr, 90)), min: r1(pct(arr, 0)), max: r1(pct(arr, 100)) } }

// gaps between sorted times, with the open gap from 0 and the one to `end`
export function gaps(ts, end) {
  const g = []
  let prev = 0
  for (const t of ts) { g.push(t - prev); prev = t }
  g.push(end - prev)
  return g
}
// events closer than `merge` s are one moment (a hunt fires alert + seen + music in a burst)
export function moments(ts, merge = 3) {
  const out = []
  for (const t of ts) if (!out.length || t - out[out.length - 1].last > merge) out.push({ t, last: t }); else out[out.length - 1].last = t
  return out.map((m) => m.t)
}
// stretches of at least `min` s with nothing in `ts` (sorted), the open ones at both ends included
export function quietStretches(ts, end, min = 45) { return gaps(ts, end).filter((g) => g >= min).length }
// lines [{ t, text }] in time order -> { shown, repeats }: a repeat is a line whose text was already shown within `window` s before it
export function repeats(lines, window = 300) {
  const last = new Map()
  let rep = 0
  for (const l of lines) { const p = last.get(l.text); if (p !== undefined && l.t - p <= window) rep++; last.set(l.text, l.t) }
  return { shown: lines.length, repeats: rep }
}
// of the times in `targets`, how many have something in `cues` between t - hi and t - lo (both sorted or not)
export function preceded(targets, cues, lo = 5, hi = 25) {
  let n = 0
  for (const t of targets) if (cues.some((c) => c >= t - hi && c <= t - lo)) n++
  return n
}

// ── the bot's plates and the says that put them up (bot/stats.mjs) ──
// queueWaitS(MSG): the longest a line can wait in a tree's message queue between its showMessage and its plate, read off the queue
// itself (MSG is that tree's messages.js; the queue built as game.js builds it, with no options), so every tree is measured by its own:
// the discovery gap (two discovery lines pushed together: the second goes up this long after the first) plus the hold (one line alone,
// from up to fading). A discovery line pushed just after another went up waits out the gap; and the line it finds on screen when the
// gap runs out keeps it no longer than its hold (the queue promotes past that one at its dwell, sooner: the hold is the safe side). The
// case that wants it: a search's result goes up over the exit hint, and the deep floor's drawer line, pushed with it, waits for the gap
// the hint started: up 6.05 s after its say, past the flat 6 s the matcher used to allow (RESULTS.md miss 2)
export function queueWaitS(MSG, dt = 0.001, capS = 120) {
  const ups = (lines, prio, until) => {
    const q = MSG.createMessageQueue(), seen = []
    for (const l of lines) q.push(l, prio)
    for (let n = 0; n * dt < capS; n++) { const r = q.tick(dt); if (r) { seen.push([n, r.text, r.show]); if (until(seen)) return seen } }
    throw new Error(`queueWaitS: the queue never ${prio === MSG.PRIO.discovery ? 'put up a second discovery line' : 'let its line fade'} in ${capS} s`)
  }
  const hold = ups(['a'], MSG.PRIO.combat, (s) => s.some((x) => !x[2]))
  const gap = ups(['a', 'b'], MSG.PRIO.discovery, (s) => s.some((x) => x[1] === 'b' && x[2]))
  const at = (s, text, show) => s.find((x) => x[1] === text && x[2] === show)[0]
  return r2((at(hold, 'a', false) - at(hold, 'a', true) + at(gap, 'b', true) - at(gap, 'a', true)) * dt)
}
// matchSays(plates, says, windowS): plates [{ t, text }] in time order (text as #msg shows it), says [{ t, text }] (showMessage's, any
// order) -> for each plate the say that put it up, or null: the latest say of its text that no earlier plate took, said no longer than
// windowS before the plate and no later than the log's frame (0.05 s) after it
export function matchSays(plates, says, windowS) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 400)
  const byT = says.map((s) => ({ s, key: norm(s.text) })).sort((a, b) => a.s.t - b.s.t)
  const used = new Set()
  return plates.map((p) => {
    for (let i = byT.length - 1; i >= 0; i--) {
      const { s, key } = byT[i]
      if (s.t > p.t + 0.05) continue
      if (p.t - s.t > windowS) break
      if (key === p.text && !used.has(i)) { used.add(i); return s }
    }
    return null
  })
}
