// gfx-attract.js — the title screen's attract mode: the REAL renderer gliding a scripted camera down a Level 0 hall, on
// its OWN canvas (#attract) behind the start menu. No game logic, no entities, no audio — a moving picture of the place.
//
//   startAttract(canvas, opts?) -> Promise<boolean>   true when something is now showing (a running loop or a single still frame)
//   stopAttract()                                     cancel the loop, release the renderer and the canvas store, hide the canvas;
//                                                     idempotent, safe before start, and what the start screen calls on every way into
//                                                     the game (index.html) — the game never inherits a running attract loop
//
//   opts.startTime   seconds along the route to start at (page.cjs / the harness use it to look at any camera position)
//   opts.still       force the single-still-frame path (what prefers-reduced-motion gets)
//   opts.env         override the detected environment { reducedMotion, coarse, deviceMemory, hardwareConcurrency, saveData }
//   opts.shouldRun   () => boolean, polled every frame; false disposes the attract (index.html: "the start screen is still up")
//   opts.onStop      called once, whenever the attract ends for any reason (stopAttract(), an error, shouldRun() false)
//
// It never touches the game canvas (#c) — startAttract() refuses it — and it does not import game.js. It reads ONE thing from the
// player's prefs (grain / particles / reduceFlicker / classic graphics, so those choices hold on the title too). It honours
// prefers-reduced-motion and the Reduce flicker pref (one still frame, and the loop stays off even if the preference flips later),
// shows a still on any low-end device, skips itself on coarse-pointer low-memory / low-core devices and on data-saver, draws at a small fixed backing size (the page CSS stretches it with object-fit: cover), caps itself at 30 fps
// and degrades to 15 fps and then to a still if the device cannot keep up.
//
// Everything below the "pure" banner is import-safe in Node and unit-tested (test/gfx-attract.test.js): the route planner, the
// path sampler, the camera, the flicker schedule, the environment decision and the frame governor. The world, the route and the
// flicker are deterministic (ATTRACT_SEED, no Math.random), so every player's title screen shows the same hall.
import { createRenderer } from './renderer.js'
import { createChunkCache, CHUNK_SIZE, DEFAULT_CONFIG } from './world.js'
import { levelConfig } from './levels.js'
import { mulberry32, hash2 } from './gfx-util.js'
import { getPref } from './prefs.js'
import { DEFAULT_MAX_GLOBAL_DIP } from './gfx-quality.js'

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────

export const ATTRACT_SEED = 0x0A77AC7          // the fixed world seed: the same lobby, the same route, for every player
export const ATTRACT_VIEW = Object.freeze({ w: 640, h: 360 })   // backing size; index.html stretches it to the window
export const TURN_RADIUS = 0.9                 // cells: the arc round a junction. Any wider and it grazes the inner wall corner (the halls are 1 cell wide)
export const GLIDE_SPEED = 0.95                // cells per second on the straights — slow, a walk in no hurry
export const TURN_SLOWDOWN = 0.55              // the camera eases to (1 - this) of its speed through a turn, so the swing round a junction is slow
const TURN_RAMP = 2.5                          // cells over which it eases in and out
const TAU = Math.PI * 2

// Every generated chunk keeps its whole middle row and middle column open (world.js: the "main hall"; world.test.js pins it), and
// the chunk borders meet at those midpoints — so the halls form a world-wide lattice of long, straight, 1-wide corridors crossing
// at junctions. A rectangle on that lattice is a closed loop of hall with a junction at every corner.
function hallLine(chunkSize, k) { return (chunkSize >> 1) + chunkSize * k }

// Are all cells on the axis-aligned run (x0,y0)->(x1,y1) open? (cells, inclusive)
function runOpen(isOpen, x0, y0, x1, y1) {
  const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0)
  let x = x0, y = y0
  for (;;) {
    if (!isOpen(x, y)) return false
    if (x === x1 && y === y1) return true
    x += dx; y += dy
  }
}

// planRoute({ isOpen(cx, cy) -> bool, chunkSize, seed }) -> route | null
// Picks a rectangle of hall (1 or 2 chunks on a side, somewhere within a chunk of the origin) from a seeded PRNG, verifies every cell
// of its perimeter is open, and returns the path through its four corners (cell centres). Deterministic in (isOpen, chunkSize, seed).
export function planRoute({ isOpen, chunkSize = CHUNK_SIZE, seed = ATTRACT_SEED, turnRadius = TURN_RADIUS } = {}) {
  const rnd = mulberry32(seed)
  const tries = []
  for (let n = 0; n < 24; n++) {
    tries.push({ i: ((rnd() * 3) | 0) - 1, j: ((rnd() * 3) | 0) - 1, w: rnd() < 0.4 ? 2 : 1, h: rnd() < 0.4 ? 2 : 1, ccw: rnd() < 0.5, start: (rnd() * 4) | 0 })
  }
  tries.push({ i: 0, j: 0, w: 1, h: 1, ccw: false, start: 0 })       // the last resort: the origin chunk's own loop
  for (const t of tries) {
    const x0 = hallLine(chunkSize, t.i), x1 = hallLine(chunkSize, t.i + t.w)
    const y0 = hallLine(chunkSize, t.j), y1 = hallLine(chunkSize, t.j + t.h)
    if (!(runOpen(isOpen, x0, y0, x1, y0) && runOpen(isOpen, x1, y0, x1, y1) && runOpen(isOpen, x1, y1, x0, y1) && runOpen(isOpen, x0, y1, x0, y0))) continue
    let corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]              // clockwise on screen (y grows downward)
    if (t.ccw) corners = [corners[0], corners[3], corners[2], corners[1]]
    corners = corners.slice(t.start).concat(corners.slice(0, t.start))
    return buildPath(corners.map(([x, y]) => [x + 0.5, y + 0.5]), turnRadius)
  }
  return null
}

// buildPath(corners, radius) -> route { segs, length, corners }
// A closed polyline of axis-aligned legs with each corner rounded by an arc of `radius` (clamped to leave room). Segments are
// { type:'line', s0, len, x0, y0, dx, dy } and { type:'arc', s0, len, cx, cy, ax, ay, dx, dy, nx, ny, r, sweep, h0 }.
export function buildPath(corners, radius = TURN_RADIUS) {
  const n = corners.length
  const dir = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, l] }
  const legs = corners.map((c, i) => dir(c, corners[(i + 1) % n]))
  let minLeg = Infinity
  for (const l of legs) if (l[2] < minLeg) minLeg = l[2]
  const r = Math.max(0.05, Math.min(radius, minLeg / 2 - 0.01))
  const segs = []
  let s = 0
  for (let i = 0; i < n; i++) {
    const cur = legs[i], nxt = legs[(i + 1) % n]
    // the straight part of leg i runs from the end of the arc at corner i to the start of the arc at corner i+1
    const start = [corners[i][0] + cur[0] * r, corners[i][1] + cur[1] * r]
    const len = cur[2] - 2 * r
    segs.push({ type: 'line', s0: s, len, x0: start[0], y0: start[1], dx: cur[0], dy: cur[1] })
    s += len
    // the arc round corner i+1: it leaves along `cur` and comes out along `nxt`
    const c = corners[(i + 1) % n]
    const ax = c[0] - cur[0] * r, ay = c[1] - cur[1] * r
    const cross = cur[0] * nxt[1] - cur[1] * nxt[0]                       // > 0: turning toward +angle (clockwise on screen)
    const sweep = cross >= 0 ? Math.PI / 2 : -Math.PI / 2
    const nx = nxt[0], ny = nxt[1]                                        // unit vector from the leg toward the arc's centre
    const alen = r * Math.PI / 2
    segs.push({ type: 'arc', s0: s, len: alen, cx: ax + nx * r, cy: ay + ny * r, ax, ay, dx: cur[0], dy: cur[1], nx, ny, r, sweep, h0: Math.atan2(cur[1], cur[0]) })
    s += alen
  }
  return { segs, length: s, corners, radius: r }
}

function norm(a) { a %= TAU; if (a > Math.PI) a -= TAU; else if (a <= -Math.PI) a += TAU; return a }

// sampleRoute(route, s) -> { x, y, heading }   s is arc length, wrapped to [0, length): the route is a closed loop
export function sampleRoute(route, s) {
  const L = route.length
  s = ((s % L) + L) % L
  const segs = route.segs
  let seg = segs[segs.length - 1]
  for (let i = 0; i < segs.length; i++) { if (s < segs[i].s0 + segs[i].len) { seg = segs[i]; break } }
  const u = Math.max(0, Math.min(seg.len, s - seg.s0))
  if (seg.type === 'line') return { x: seg.x0 + seg.dx * u, y: seg.y0 + seg.dy * u, heading: Math.atan2(seg.dy, seg.dx) }
  const th = (u / seg.len) * (Math.PI / 2)
  // P(theta) = C - n r cos(theta) + d r sin(theta)  (theta = 0 at the arc's start, pi/2 at its end)
  const x = seg.cx - seg.nx * seg.r * Math.cos(th) + seg.dx * seg.r * Math.sin(th)
  const y = seg.cy - seg.ny * seg.r * Math.cos(th) + seg.dy * seg.r * Math.sin(th)
  return { x, y, heading: norm(seg.h0 + Math.sign(seg.sweep) * th) }
}

// The speed profile: GLIDE_SPEED on the straights, easing down to (1 - TURN_SLOWDOWN) of it through each turn (smoothly, over TURN_RAMP
// cells either side of the arc), so a junction is a slow swing rather than a snap. A route's timeline is a table of cumulative time
// against path length, built once per (route, speed) — cameraAt() inverts it by binary search.
const smooth = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x) }
const TIMELINES = new WeakMap()
function timeline(route, speed) {
  let byS = TIMELINES.get(route)
  if (!byS) { byS = new Map(); TIMELINES.set(route, byS) }
  let tl = byS.get(speed)
  if (tl) return tl
  const ds = 0.05, n = Math.ceil(route.length / ds), step = route.length / n
  const arcs = route.segs.filter((g) => g.type === 'arc')
  const T = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const sm = (i + 0.5) * step
    let d = Infinity                                     // distance from sm to the nearest arc (the route is a loop: wrap)
    for (const g of arcs) {
      const lo = g.s0, hi = g.s0 + g.len
      const dd = sm < lo ? Math.min(lo - sm, sm + route.length - hi) : sm > hi ? Math.min(sm - hi, lo + route.length - sm) : 0
      if (dd < d) d = dd
    }
    T[i + 1] = T[i] + step / (speed * (1 - TURN_SLOWDOWN * smooth(1 - d / TURN_RAMP)))
  }
  tl = { T, step, n, period: T[n] }
  byS.set(speed, tl)
  return tl
}

// routePeriod(route, speed?) -> seconds for one full lap at that glide speed
export function routePeriod(route, speed = GLIDE_SPEED) { return timeline(route, speed).period }

// pathPosAt(route, t, speed?) -> arc length s at time t (the loop wraps)
export function pathPosAt(route, t, speed = GLIDE_SPEED) {
  const tl = timeline(route, speed)
  const tt = ((t % tl.period) + tl.period) % tl.period
  let lo = 0, hi = tl.n
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tl.T[mid] <= tt) lo = mid; else hi = mid }
  const f = (tt - tl.T[lo]) / (tl.T[lo + 1] - tl.T[lo] || 1)
  return (lo + f) * tl.step
}

// cameraAt(route, t, opts?) -> { x, y, angle, bobOffset, moving, s }
// The slow glide with a little life in it: the view sways a few degrees on two incommensurate periods, and the head rises and falls
// by a pixel or two. `t` is seconds. All smooth, all deterministic. opts.calm = no sway/bob (the still frame); opts.speed overrides.
export function cameraAt(route, t, opts = {}) {
  const s = pathPosAt(route, t, opts.speed ?? GLIDE_SPEED)
  const p = sampleRoute(route, s)
  const calm = opts.calm ? 0 : 1
  const sway = calm * (0.035 * Math.sin(t * 0.37 + 0.6) + 0.02 * Math.sin(t * 0.91 + 1.3))
  return { x: p.x, y: p.y, angle: p.heading + sway, bobOffset: calm * 1.4 * Math.sin(t * TAU * 0.42), moving: !opts.calm, s }
}

// The pose the reduced-motion still frame uses: a third of the way down the first long straight, looking down the hall.
export function stillPose(route) {
  let best = route.segs[0]
  for (const g of route.segs) if (g.type === 'line' && g.len > best.len) best = g
  const p = sampleRoute(route, best.s0 + best.len * 0.34)
  return { x: p.x, y: p.y, angle: p.heading, bobOffset: 0, moving: false }
}

// flickerAt(t, seed?) -> 0.8..1   the hum of the tubes. Steady breathing, and at most one soft dip per ~11 s (0.2 s long, to ~0.83):
// far inside WCAG 2.3.1 (no more than 3 flashes/second, and no large-area strobing) — a hint that the light is alive, not an effect.
export function flickerAt(t, seed = ATTRACT_SEED) {
  let f = 0.975 + 0.025 * Math.sin(t * 1.7)
  const P = 11
  const win = Math.floor(t / P)
  const at = win * P + 2.5 + (hash2(win, 7, seed) % 1000) / 1000 * 7        // this window's dip starts between 2.5 s and 9.5 s in
  const d = t - at
  if (d >= 0 && d < 0.22) { const k = Math.sin((d / 0.22) * Math.PI); f -= 0.15 * k * k }
  return f
}

// attractPlan(env) -> { mode: 'animate' | 'still' | 'skip', reason }
//   env = { reducedMotion, coarse, deviceMemory (GB, Chromium only), hardwareConcurrency, saveData }
// Skip wins over still: a coarse-pointer device with little memory (<= 2 GB) or few cores (<= 2), or with data-saver on, gets the
// plain title page. Reduced motion (the OS query OR the in-game Reduce flicker pref) gets one frame, and so does any other low-end
// device (same test as gfx-quality's deviceClass() === 'low': a clamshell Chromebook has a fine pointer but the same weak CPU).
export function attractPlan(env = {}) {
  const lowEnd = (env.deviceMemory != null && env.deviceMemory <= 2) || (env.hardwareConcurrency != null && env.hardwareConcurrency <= 2)
  if (env.saveData) return { mode: 'skip', reason: 'save-data' }
  if (env.coarse && lowEnd) return { mode: 'skip', reason: 'low-memory touch device' }
  if (env.reducedMotion) return { mode: 'still', reason: 'reduced motion' }
  if (lowEnd) return { mode: 'still', reason: 'low-end device' }
  return { mode: 'animate', reason: '' }
}

// The frame governor. Pure state machine: feed it the wall-clock gap between two drawn frames, it says how often to draw.
//   level 0: 30 fps    level 1: 15 fps (after a sustained average gap > 1.8x the target)    level 2: give up — one still frame
export function createGovernor() { return { level: 0, ema: 0, n: 0 } }
export const GOVERNOR_INTERVAL_MS = [1000 / 30, 1000 / 15]
export function governorStep(g, gapMs) {
  const target = GOVERNOR_INTERVAL_MS[Math.min(g.level, 1)]
  g.ema = g.n === 0 ? gapMs : g.ema * 0.9 + gapMs * 0.1
  g.n++
  if (g.level < 2 && g.n >= 45 && g.ema > target * 1.8) { g.level++; g.n = 0; g.ema = 0 }
  return { level: g.level, intervalMs: GOVERNOR_INTERVAL_MS[Math.min(g.level, 1)], stop: g.level >= 2 }
}

// ── runtime (browser only; every DOM touch is inside these functions) ─────────────────────────────────

let active = null   // the one running attract session, or null

function detectEnv() {
  const w = typeof window !== 'undefined' ? window : null
  const mm = (q) => { try { return !!(w && w.matchMedia && w.matchMedia(q).matches) } catch { return false } }
  const nav = typeof navigator !== 'undefined' ? navigator : {}
  return {
    reducedMotion: mm('(prefers-reduced-motion: reduce)') || getPref('reduceFlicker') === true,   // the OS query OR the in-game pref
    coarse: mm('(pointer: coarse)'),
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    saveData: !!(nav.connection && nav.connection.saveData),
  }
}

export function getAttractStats() { return active ? { ...active.stats } : null }

export async function startAttract(canvas, opts = {}) {
  if (typeof document === 'undefined' || !canvas) return false
  if (canvas.id === 'c') throw new Error('gfx-attract: refusing to draw on the game canvas #c')
  stopAttract()
  const env = { ...detectEnv(), ...(opts.env || {}) }
  const plan = attractPlan(env)
  const still = opts.still || plan.mode === 'still'
  const setState = (s) => { try { canvas.dataset.state = s } catch { /* detached */ } }
  if (plan.mode === 'skip') { setState('skipped: ' + plan.reason); return false }

  const session = { dead: false, raf: 0, renderer: null, canvas, onStop: opts.onStop || null, stats: { frames: 0, avgRenderMs: 0, level: 0, mode: still ? 'still' : 'animate' }, cleanups: [] }
  active = session
  setState('starting')
  try {
    const cfg = levelConfig(DEFAULT_CONFIG, 0)
    const cache = createChunkCache(cfg, ATTRACT_SEED)
    cache.preload(0, 0)
    const route = planRoute({ isOpen: (cx, cy) => !cache.isWall(cx + 0.5, cy + 0.5), seed: ATTRACT_SEED })
    if (!route) throw new Error('no route')

    canvas.width = ATTRACT_VIEW.w; canvas.height = ATTRACT_VIEW.h
    const ropts = { grain: getPref('grain') !== false, particles: getPref('particles') !== false, crosshair: false, qualityTier: getPref('graphicsQuality') === 'legacy' ? 'legacy' : 'low', maxGlobalDip: DEFAULT_MAX_GLOBAL_DIP, reduceFlicker: !!env.reducedMotion }
    const renderer = createRenderer(canvas, cfg, ropts, {})
    session.renderer = renderer

    const player = { x: 0, y: 0, angle: 0, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
    const t0 = opts.startTime || 0
    const draw = (t, dt, calm) => {
      const cam = calm ? stillPose(route) : cameraAt(route, t)
      player.x = cam.x; player.y = cam.y; player.angle = cam.angle; player.bobOffset = cam.bobOffset; player.moving = cam.moving
      const pcx = Math.floor(cam.x / CHUNK_SIZE), pcy = Math.floor(cam.y / CHUNK_SIZE)
      const t1 = performance.now()
      const wallFn = (wx, wy) => cache.isWall(wx, wy, pcx, pcy)
      wallFn.pcx = pcx; wallFn.pcy = pcy          // the chunk handed to the cache: lets the rays' isWall memo on (gfx-world.js memoSafe; default evict radius)
      renderer.render(player, wallFn, calm ? 1 : flickerAt(t), [], 1, {}, { t, dt })
      const ms = performance.now() - t1
      session.stats.frames++
      session.stats.avgRenderMs += (ms - session.stats.avgRenderMs) * 0.1
    }

    // the first frame is drawn synchronously, so the canvas never shows a blank store, then the canvas fades in over the page
    draw(t0, 1 / 60, still && opts.startTime === undefined)     // a plain still (reduced motion) holds the flattering pose
    canvas.style.display = 'block'
    if (!env.reducedMotion) { canvas.style.opacity = '0'; canvas.style.transition = 'opacity 1.4s ease'; session.raf = requestAnimationFrame(() => { if (!session.dead) canvas.style.opacity = '1' }) }
    else { canvas.style.opacity = '1' }

    if (still) { setState('still'); session.stats.mode = 'still'; return true }

    // the loop: capped at 30 fps, degraded by the governor, ended by shouldRun()/stopAttract()
    const gov = createGovernor()
    let last = performance.now(), simT = t0, lastDraw = last
    const frame = (now) => {
      if (session.dead) return
      session.raf = requestAnimationFrame(frame)
      if (opts.shouldRun && !opts.shouldRun()) { stopAttract(); return }
      const interval = GOVERNOR_INTERVAL_MS[Math.min(gov.level, 1)]
      if (now - lastDraw < interval - 1) return
      const gap = Math.min(now - lastDraw, 200)         // (a tab that was hidden for a minute is not a slow device)
      lastDraw = now
      const dt = Math.min(0.1, (now - last) / 1000)   // a hidden tab pauses rAF; do not lurch forward on return
      last = now
      simT += dt
      try { draw(simT, dt, false) } catch (e) { setState('error'); stopAttract(); return }
      const g = governorStep(gov, gap)
      session.stats.level = g.level
      if (g.stop) { setState('still'); cancelAnimationFrame(session.raf); session.raf = 0; session.stats.mode = 'still' }
    }
    // the preference can flip while the page is open: reduced motion turns the loop into a held frame
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      const onChange = () => { if (mq.matches && !session.dead) { cancelAnimationFrame(session.raf); session.raf = 0; setState('still'); session.stats.mode = 'still' } }
      if (mq.addEventListener) { mq.addEventListener('change', onChange); session.cleanups.push(() => mq.removeEventListener('change', onChange)) }
    } catch { /* no matchMedia */ }
    session.raf = requestAnimationFrame(frame)
    setState('running')
    return true
  } catch (e) {
    setState('error')
    stopAttract()
    return false
  }
}

export function stopAttract() {
  const s = active
  if (!s) return
  active = null
  s.dead = true
  if (s.raf) { try { cancelAnimationFrame(s.raf) } catch { /* none */ } s.raf = 0 }
  for (const fn of s.cleanups) { try { fn() } catch { /* none */ } }
  s.cleanups.length = 0
  try { if (s.renderer && s.renderer.dispose) s.renderer.dispose() } catch { /* none */ }
  s.renderer = null
  const c = s.canvas
  if (s.onStop) { try { s.onStop() } catch { /* the host's problem */ } s.onStop = null }
  try {
    c.style.display = 'none'; c.style.opacity = ''; c.style.transition = ''
    c.width = 0; c.height = 0                       // release the backing store
    if (!c.dataset.state || !/^(error|skipped)/.test(c.dataset.state)) c.dataset.state = 'stopped'
  } catch { /* detached */ }
}
