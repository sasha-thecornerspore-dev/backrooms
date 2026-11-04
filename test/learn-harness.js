// learn-harness.js — scripted runs of the real entity system on a real chunk cache, hashed frame by frame, for the identity tests
// in learn.test.js (M19, creatures that learn your habits). Not a test file itself (vitest runs test/**/*.test.js only).
//
// A scenario is a fixed script: where you start (its `start`, else 11.5, 11.5) and face, whether the file's reading hides you
// (aiCtx.hidden), the noises you make, the wards and the flashes you throw. Every creature of every variant is placed on the same
// open cells each time. The hash folds each frame's creatures (id, x, y, dir, stagger, wardHits, ai, state) and its events (kind, id,
// d) into 64 bits, so two runs agree only when they agree byte for byte. The golden hashes in learn.test.js were taken from this
// harness on the code before M19 (36ac9a4: `git archive 36ac9a4 src` beside a copy of this file reproduces them). The scripts that
// must stay clean of a method say so: 'still', 'run', 'flash' never ward; 'still', 'run', 'ward' never flash; 'run', 'ward', 'flash'
// never hide you; 'still' shows you for under the 3.5 s any hunt needs to lose you, then hides you for good (no loss while you are seen).
//
// run(name, { learn, keepEscapes, onFrame, at }) -> { hash, kinds, left }: `learn` is handed to sys.setLearn when the system has one
// (the M19 seam); escape events (kind 'escape-*') are left out of the hash unless keepEscapes, and every kind is counted in `kinds`;
// onFrame(i, sys, s) looks at each frame after its update and must change nothing; `at` ({ x, y, angle, walk }) overrides the start
// and the flash script's walk heading, for looking for a script (the tests never pass it).
import { createEntitySystem } from '../src/renderer/entities.js'
import { createChunkCache, createGridReader, CHUNK_SIZE } from '../src/renderer/world.js'
import { creatureRadius } from '../src/renderer/collide.js'
import { HF, FOV } from '../src/renderer/gfx-frame.js'

const DT = 1 / 60
const N = CHUNK_SIZE
const VARIANTS = ['shade', 'smiler', 'hound', 'lurker', 'watcher', 'crawler', 'tesla']

// FNV-1a over 64-bit floats, two lanes
function hasher() {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer)
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995
  const word = (w) => {
    for (let k = 0; k < 4; k++) { a = Math.imul(a ^ ((w >>> (k * 8)) & 255), 16777619) >>> 0; b = Math.imul(b ^ ((w >>> (k * 8)) & 255), 0x01000193 + 2) >>> 0 }
  }
  return {
    num(x) { f[0] = x; word(u[0]); word(u[1]) },
    str(s) { for (let i = 0; i < s.length; i++) word(s.charCodeAt(i)); word(0xffff) },
    hex() { return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') },
  }
}

function world() {
  const cfg = { chunkEvictRadius: 3, maze: { corridor: 1 }, entities: { enabled: false, damage: 16 } }
  const cache = createChunkCache(cfg, 0)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  const grid = createGridReader(cache, isWall)
  return { cfg, cache, isWall, grid }
}

// the open cells of chunk (0,0) and (0,1), in scan order
function openCells(grid) {
  const out = []
  for (let iy = 1; iy < 2 * N - 1; iy++) for (let ix = 1; ix < N - 1; ix++) if (grid.floor(ix, iy)) out.push([ix, iy])
  return out
}

// fourteen creatures, two of each variant, on open cells 5 u or more from the start (11.5, 11.5), spread over the scan
function place(sys, grid) {
  const cells = openCells(grid).filter(([ix, iy]) => Math.hypot(ix + 0.5 - 11.5, iy + 0.5 - 11.5) >= 5)
  const list = sys.getEntities()
  const step = Math.max(1, Math.floor(cells.length / 14))
  for (let k = 0; k < 14; k++) {
    const [ix, iy] = cells[(k * step + 3) % cells.length]
    list.push({ id: 100 + k, x: ix + 0.5, y: iy + 0.5, type: 'stalker', variant: VARIANTS[k % 7], state: 'idle', dir: (k * 1.7) % (Math.PI * 2),
      dirTimer: 1 + k * 0.37, stagger: 0, wardHits: 0, chunkCx: Math.floor((ix + 0.5) / N), chunkCy: Math.floor((iy + 0.5) / N) })
  }
}

function nearestAngle(sys, p) {
  let best = null, bd = Infinity
  for (const e of sys.getEntities()) { const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2; if (d < bd) { bd = d; best = e } }
  return best ? Math.atan2(best.y - p.y, best.x - p.x) : p.angle
}

// try one step of (dx, dy); refused when it would land in a wall cell
function walk(grid, p, dx, dy) {
  const nx = p.x + dx, ny = p.y + dy
  if (grid.floor(Math.floor(nx), Math.floor(p.y))) p.x = nx
  if (grid.floor(Math.floor(p.x), Math.floor(ny))) p.y = ny
}

// the scripts: each frame (i, t) moves the player, sets the ctx, and may ward / flash / make a noise
const SCRIPTS = {
  // you never hide: you stand in the open, then run down the hall and stop far off; hunts end by the line breaking
  run: { seconds: 45, step(s, i, t) {
    const { p, ctx, sys, grid } = s
    ctx.hidden = false
    if (t < 1.5) { p.angle += 0.02; return }
    if (t < 9) { p.angle = Math.PI / 2; walk(grid, p, 0, 4.2 * DT); ctx.sprinting = true; if (i % 18 === 0) sys.noise(p.x, p.y, 7); return }
    if (t < 13) { p.angle = Math.PI; walk(grid, p, -3 * DT, 0); ctx.sprinting = false; if (i % 24 === 0) sys.noise(p.x, p.y, 3); return }
    ctx.sprinting = false; p.angle += 0.004
  } },
  // you stand in the open and stamp for a breath (under the 3.5 s any hunt needs to lose you), then the file hides you for good and you never move again
  still: { seconds: 45, start: { x: 8.5, y: 4.5 }, step(s, i, t) {
    const { p, ctx } = s
    ctx.sprinting = false
    if (t < 3.3) { ctx.hidden = false; p.angle += 0.03; if (i % 15 === 0) s.sys.noise(p.x, p.y, 7); return }
    ctx.hidden = true
  } },
  // you hold your ground and push at whatever is nearest, every two and a half seconds; never hidden
  ward: { seconds: 35, step(s, i, t) {
    const { p, ctx, sys } = s
    ctx.hidden = false
    p.angle = nearestAngle(sys, p)
    if (i > 0 && i % 150 === 0) { sys.ward(p, i % 300 === 0 ? { range: 4.2, cone: 0.32 * Math.PI, knockback: 2.6, hits: 2 } : {}); sys.noise(p.x, p.y, 12) }
  } },
  // you hold your ground and flash whatever is nearest every three seconds, and from the last one walk off while they reel; never hidden
  flash: { seconds: 40, start: { x: 17.5, y: 33.5 }, walk: 0, step(s, i, t) {
    const { p, ctx, sys, grid } = s
    ctx.hidden = false
    if (i <= 720) { p.angle = nearestAngle(sys, p); if (i > 0 && i % 180 === 0) { sys.noise(p.x, p.y, 9); sys.flash(p, { range: 6, cone: FOV, stagger: 1.8 }) } return }
    if (t < 18) { p.angle = s.walk; walk(grid, p, Math.cos(s.walk) * 3.6 * DT, Math.sin(s.walk) * 3.6 * DT); return }
    p.angle += 0.004
  } },
  // everything: a dark floor, the light on and off, walking, hiding, warding, flashing
  mixed: { seconds: 70, step(s, i, t) {
    const { p, ctx, sys, grid } = s
    ctx.dark = true
    ctx.flashlight = (i % 600) < 400
    const phase = Math.floor(t / 7) % 5
    ctx.hidden = phase === 3
    if (phase === 0 || phase === 2) { p.angle = phase === 0 ? Math.PI / 2 : -Math.PI / 2; walk(grid, p, 0, (phase === 0 ? 1 : -1) * 3.6 * DT); if (i % 20 === 0) sys.noise(p.x, p.y, 7) }
    else if (phase === 1) { p.angle = nearestAngle(sys, p); if (i % 140 === 0) { sys.ward(p); sys.noise(p.x, p.y, 12) } }
    else if (phase === 4) { p.angle = nearestAngle(sys, p); if (i % 170 === 0) { sys.noise(p.x, p.y, 9); sys.flash(p, { range: 6, cone: FOV, stagger: 1.8 }) } }
    ctx.sprinting = phase === 0 || phase === 2
  } },
}
export const SCENARIOS = Object.freeze(Object.keys(SCRIPTS))

export function run(name, { learn, keepEscapes = false, onFrame = null, at = null } = {}) {
  const sc = SCRIPTS[name]
  const { cfg, isWall, grid } = world()
  let t = 0
  const obstacles = { blocked: () => false, radiusFor: creatureRadius }
  const sys = createEntitySystem(cfg, isWall, { grid, obstacles, now: () => t })
  if (learn !== undefined && typeof sys.setLearn === 'function') sys.setLearn(learn)
  place(sys, grid)
  const p = { x: at ? at.x : sc.start ? sc.start.x : 11.5, y: at ? at.y : sc.start ? sc.start.y : 11.5, angle: at ? at.angle ?? 0 : 0 }
  const ctx = { flashlight: false, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player: p, damage: 16,
    sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
  const s = { p, ctx, sys, grid, walk: at && at.walk !== undefined ? at.walk : sc.walk ?? 0 }
  const h = hasher(), out = [], kinds = {}
  const n = Math.round(sc.seconds / DT)
  for (let i = 0; i < n; i++) {
    sc.step(s, i, i * DT)
    ctx.t = t; ctx.playerAngle = p.angle
    sys.update(DT, p, Math.floor(p.x / N), Math.floor(p.y / N), ctx)
    t += DT
    const m = sys.drainEvents(out)
    for (let k = 0; k < m; k++) {
      const ev = out[k]
      kinds[ev.kind] = (kinds[ev.kind] || 0) + 1
      if (!keepEscapes && ev.kind.startsWith('escape-')) continue
      h.str(ev.kind); h.num(ev.id); h.num(ev.d)
    }
    if (onFrame) onFrame(i, sys, s)
    for (const e of sys.getEntities()) {
      h.num(e.id); h.num(e.x); h.num(e.y); h.num(e.dir); h.num(e.stagger); h.num(e.wardHits); h.str(e.ai); h.str(e.state)
    }
  }
  return { hash: h.hex(), kinds, left: sys.getEntities().length }
}
