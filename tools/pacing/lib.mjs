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
// replayQueue(MSG, pushes, { dt, untilS, clears }): a tree's message queue (MSG is that tree's messages.js; the queue built as game.js
// builds it, with no options) fed pushes [[t, text, prio]] as showMessage feeds it and ticked every dt as the frame loop ticks it, and
// cleared at each time in `clears` (frame times) as buildLevel clears it: in the fade's timeout, after that frame's tick, with the pushes
// of that instant said after the clear (the floor's line) -> { plates, says }: what it put up [{ t, text }] and what was said [{ t, text }],
// on the play clock to 0.01 s as the bot logs them (a plate at the time of the frame whose tick put it up)
export function replayQueue(MSG, pushes, { dt = 1 / 60, untilS = 60, clears = [] } = {}) {
  const q = MSG.createMessageQueue(), plates = [], says = []
  const ps = [...pushes].sort((a, b) => a[0] - b[0]), cs = [...clears].sort((a, b) => a - b)
  const atClear = (x) => cs.some((cc) => Math.abs(cc - x) < 1e-9)
  let i = 0, c = 0
  for (let n = 0; n * dt <= untilS + 1e-9; n++) {
    const t = r2(n * dt)
    const say = () => { q.push(ps[i][1], ps[i][2]); says.push({ t, text: ps[i][1] }); i++ }
    while (i < ps.length && ps[i][0] <= t + 1e-9 && !atClear(ps[i][0])) say()
    const r = q.tick(dt)
    if (r?.show) plates.push({ t, text: r.text })
    if (c < cs.length && cs[c] <= t + 1e-9) {
      while (c < cs.length && cs[c] <= t + 1e-9) { q.clear(); c++ }
      while (i < ps.length && ps[i][0] <= t + 1e-9) say()
    }
  }
  return { plates, says }
}
// queueBound(MSG, n): what bounds a line's wait in a tree's message queue between its showMessage and its plate, read off the queue
// itself -> { keepsS, clears }. No fixed window does:
//   keepsS  how long the last of n discovery lines said together waits for its plate (null: the queue let it go). The queue drops no
//           discovery line, so a line waits out the gap of every one said before it: the extension's three closing lines and a landmark's
//           first-sight line said 0.4 s after the last of them put the sight line up 12.05 s after its say, past the discovery gap plus
//           the hold (10.2 s) that review batch five's matcher allowed
//   clears  whether clear() drops every line still waiting (game.js buildLevel clears the queue at each arrival: buildLevelClears).
//           Then nothing said before an arrival goes up after it, and the arrival is the one bound on a plate's say
export function queueBound(MSG, n = 40) {
  const P = MSG.PRIO
  const line = (i) => `line ${i}`
  const many = replayQueue(MSG, Array.from({ length: n }, (_, i) => [0, line(i), P.discovery]), { dt: 0.01, untilS: 60 * n })
  const last = many.plates.find((p) => p.text === line(n - 1))
  // one line up, one of each other priority waiting behind it, then the arrival's clear
  const waiting = ['waits (discovery)', 'waits (interaction)', 'waits (combat)']
  const cleared = replayQueue(MSG, [[0, 'up', P.combat], [0.01, waiting[0], P.discovery], [0.01, waiting[1], P.interaction], [0.01, waiting[2], P.combat]],
    { dt: 0.01, untilS: 60, clears: [0.02] })
  return { keepsS: last ? last.t : null, clears: !cleared.plates.some((p) => waiting.includes(p.text)) }
}
// buildLevelClears(game): whether a tree's game.js (its source, or the bot's instrumented copy) clears its message queue in buildLevel,
// which every arrival (a travel, a wake on another floor) runs
export function buildLevelClears(game) {
  const m = /\n( *)function buildLevel\([^)]*\) \{\n([\s\S]*?)\n\1\}\n/.exec(String(game).replace(/\r\n/g, '\n'))
  return !!m && /\bmsgQ\.clear\(\)/.test(m[2])
}
// arrivalClears(rows): the bot's log rows (log.jsonl, file order) -> the play times its queue was cleared: every 'level' row but the
// first. buildLevel runs in the fade's timeout, between two frames, and the floor's line is said just after it; the bot's frame runs at
// the head of the next one (bot.js wraps requestAnimationFrame), before the game's frame moves the play clock, so its 'level' row has the
// clear's play time. Its first 'level' row is its own first frame on the floor the game started on. A travel F turned away (the way still
// closing) logs 'travel' and builds nothing, and a wake on the floor you died on builds no level: neither clears, and neither logs 'level'
export function arrivalClears(rows) {
  return rows.filter((r) => r.k === 'level').slice(1).map((r) => r.t)
}
// matchSays(plates, says, clears): plates [{ t, text }] in time order (text as #msg shows it), says [{ t, text }] (showMessage's, any
// order), clears the times the queue was cleared (arrivalClears; none: one arrival) -> for each plate the say that put it up, or null:
// the latest say of its text that no earlier plate took, said in the plate's own arrival and no later than the log's frame (0.05 s)
// after the plate. However long the line waited in the queue (queueBound: the arrival is the one bound). At a clear's instant a say was
// said after the clear (the floor's line), and a plate was put up before it: the bot read #msg in that frame's head, and only the game's
// frame, which comes after it, writes #msg (msgQ.tick). A plate with no say is a boot line, said before the bot's hooks
export function matchSays(plates, says, clears = []) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 400)
  const cs = [...clears].sort((a, b) => a - b)
  const arrival = (t, atClear) => { let a = 0; while (a < cs.length && (cs[a] < t || (atClear && cs[a] === t))) a++; return a }
  const byT = says.map((s) => ({ s, key: norm(s.text), at: arrival(s.t, true) })).sort((a, b) => a.s.t - b.s.t)
  const used = new Set()
  return plates.map((p) => {
    const at = arrival(p.t, false)
    for (let i = byT.length - 1; i >= 0; i--) {
      const { s, key, at: sat } = byT[i]
      if (s.t > p.t + 0.05 || sat > at) continue
      if (sat < at) break
      if (key === p.text && !used.has(i)) { used.add(i); return s }
    }
    return null
  })
}

// timedArrivalLines(tree) -> Set: the lines game.js says on its own timer a few seconds into an arrival (later()), read off the measured
// tree's own modules, so a key the bot pressed in the 2.5 s before one of them is not taken for its cause: the filing line for every column
// and layer (origin-intake.js filingLine), a floor you come back to (compass.js arrivalSummary, with any count of ways down), each way's line
// (topology.js wayMessage), the pin's mercy (origin-anchored.js MERCY_LINE), where you woke (death.js resolveDeath), and what game.js's
// later() says as written ('the floor remembers you less.'). tree: { intake, compass, topology, anchored, death } the modules (any may be
// missing), game its game.js text. The wake's other two (what your hands let go, by ITEM_NAMES in game.js; the file's word, compose-gates.js)
// are not read: no measured bot has died
export function timedArrivalLines({ intake, compass, topology, anchored, death, game = '' } = {}) {
  const out = new Set()
  const add = (s) => { if (typeof s === 'string' && s) out.add(s) }
  if (typeof intake?.filingLine === 'function') for (const o of intake.ORIGINS ?? []) for (const thin of [false, true]) add(intake.filingLine(o, thin))
  if (typeof compass?.arrivalSummary === 'function') for (let d = 0; d <= 16; d++) add(compass.arrivalSummary({ down: d }, 2))
  if (typeof topology?.wayMessage === 'function') {
    for (const kind of ['down', 'up', 'lift', 'ring']) {
      add(topology.wayMessage({ kind, target: 0 }, { before: true }))
      for (const partner of [null, {}]) for (const mem of [null, { x: 0, y: 0 }]) add(topology.wayMessage({ kind, target: 0 }, { partner, mem }))
    }
  }
  add(anchored?.MERCY_LINE)
  if (typeof death?.resolveDeath === 'function') add(death.resolveDeath({ level: 1, inventory: [], selected: 0, maxHp: 100, deaths: 0 }).message)
  for (const m of String(game).matchAll(/\blater\(\s*\d+\s*,\s*'([^'\\\n]+)'/g)) add(m[1])
  return out
}

// sayCause(say, ctx): whose a plate's say is, by the rules RESULTS.md's method gives (stats.mjs classes every plate by it). say { t, text,
// happening } (happening: said in the instant an event or a haunt fired, no drawer rolled), or null; ctx.keys the times of the bot's act
// keys, ctx.moves of its travels and deaths, ctx.timed timedArrivalLines, ctx.unprompted the tree's murmurs, hints and setting's line,
// ctx.bumps its bump, clutter and landmark lines ->
//   'player'      a bump, clutter or landmark line, key or no key; else a line said within playerS after an act key (a key logged in the
//                 say's own frame, 0.05 s, came first), not an arrival's, an event's or a haunt's, and not one of the tree's unprompted
//   'arrival'     one of the arrival's timed lines, whatever key came between and however late the budget let it go; or any line said
//                 within arrivalS of a travel or a death with no act key since (whichever came last decides: a key you pressed after you
//                 arrived is yours; the travel your F started is not)
//   'unprompted'  anything else
//   null          no say: a boot line, said before the bot's hooks
export function sayCause(say, { keys = [], moves = [], timed = null, unprompted = null, bumps = null, arrivalS = 12, playerS = 2.5 } = {}) {
  if (!say) return null
  const before = (list) => { let b = -Infinity; for (const x of list) if (x <= say.t + 0.05 && x > b) b = x; return b }
  const lastKey = before(keys), lastMove = before(moves)
  if (bumps?.has(say.text)) return 'player'
  if (timed?.has(say.text) || (lastMove >= lastKey && say.t - lastMove <= arrivalS)) return 'arrival'
  if (!say.happening && !unprompted?.has(say.text) && say.t - lastKey <= playerS) return 'player'
  return 'unprompted'
}
