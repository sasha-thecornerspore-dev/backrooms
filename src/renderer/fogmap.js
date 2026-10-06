// fogmap.js — the pencil sheet: only what you have walked, and small glyphs for what you have seen.
//
// Per level, per chunk, one 61-byte bitfield (22x22 = 484 cells) of walked cells. step() is O(1) until the player's cell changes; then it
// flood-fills from the player's cell through OPEN cells only (4-connected) to Chebyshev radius r on fixed scratch arrays, so parallel
// halls you never entered stay blank. EPOCHS: when the cache has regenerated a chunk (epochOf differs from the one stored) its bits are
// NOT cleared: the chunk is flagged faded (drawn at 0.22), its epoch updated, and what you walk from then on goes into a second 'fresh'
// bitfield as well, so re-walked strokes draw dark over the ghost of the old ones. Pins (ways, machines, sights, notes, arrivals, hurts)
// are keyed records; a way pin whose chunk went stale and is not where you drew it is 'lost' (drawn hollow, dropped from the compass).
// Pure: no DOM, no clock. export() is plain JSON (cached base64 per chunk) for the save.
import { CHUNK_SIZE } from './world.js'
import { WAY_KINDS, waysFor } from './topology.js'

export const CELL_BYTES = 61                                  // ceil(22 * 22 / 8)
export const MAX_CHUNKS = 400                                 // per level: ~24 KB of bits, then the farthest chunk goes
export function revealRadius(level) { return level <= 1 ? 3 : 2 }

const N = CHUNK_SIZE
const MAX_R = 3                                               // the flood's scratch arrays are sized for this
const W = 2 * MAX_R + 1                                       // 7: the visited window is W x W = 49
const TRAIL = 8
const HURT_KEEP = 12
const isWayKind = (t) => WAY_KINDS.indexOf(t) !== -1

// ── base64 over bytes, hand-rolled so node and the browser agree without btoa ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const REV = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) REV[B64.charCodeAt(i)] = i

export function packBits(u8) {
  let s = ''
  let i = 0
  for (; i + 2 < u8.length; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]
    s += B64[v >> 18 & 63] + B64[v >> 12 & 63] + B64[v >> 6 & 63] + B64[v & 63]
  }
  if (i < u8.length) {
    const rest = u8.length - i
    const v = (u8[i] << 16) | (rest > 1 ? u8[i + 1] << 8 : 0)
    s += B64[v >> 18 & 63] + B64[v >> 12 & 63] + (rest > 1 ? B64[v >> 6 & 63] : '=') + '='
  }
  return s
}

// the bytes of `s`, or null when it is not base64 of exactly `len` bytes
export function unpackBits(s, len = CELL_BYTES) {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null
  let pad = 0
  if (s.endsWith('==')) pad = 2
  else if (s.endsWith('=')) pad = 1
  const bytes = (s.length / 4) * 3 - pad
  if (bytes !== len) return null
  const out = new Uint8Array(bytes)
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2), d = s.charCodeAt(i + 3)
    const ra = a < 128 ? REV[a] : -1, rb = b < 128 ? REV[b] : -1
    const rc = c === 61 ? 0 : (c < 128 ? REV[c] : -1), rd = d === 61 ? 0 : (d < 128 ? REV[d] : -1)
    if (ra < 0 || rb < 0 || rc < 0 || rd < 0) return null
    const v = (ra << 18) | (rb << 12) | (rc << 6) | rd
    if (o < bytes) out[o++] = v >> 16 & 255
    if (o < bytes) out[o++] = v >> 8 & 255
    if (o < bytes) out[o++] = v & 255
  }
  return out
}

const popcount8 = new Uint8Array(256)
for (let i = 0; i < 256; i++) popcount8[i] = (i & 1) + popcount8[i >> 1]
function popcount(u8) { let n = 0; for (let i = 0; i < u8.length; i++) n += popcount8[u8[i]]; return n }

function newChunk(cx, cy, epoch) { return { cx, cy, bits: new Uint8Array(CELL_BYTES), fresh: null, epoch, faded: false, b64: null, fb64: null } }

export function createFogMap() {
  const levels = new Map()                                    // level -> { chunks: Map key -> chunk, pins: Map key -> pin, ways: [], arrived }
  // the flood's scratch: offsets from the player's cell (they fit Int16; world cells need not)
  const queue = new Int16Array(2 * W * W)
  const visited = new Uint8Array(W * W)
  const res = { marked: true, smudged: false }
  const counts = { down: 0, up: 0, lift: 0, ring: 0 }
  const trailX = new Float64Array(TRAIL), trailY = new Float64Array(TRAIL)
  let trailN = 0                                              // trail[0] is the newest
  let lastLevel = null, lastIx = NaN, lastIy = NaN
  let tick = 0                                                // pin order: the t of the next pin
  let mL = null, mcx = NaN, mcy = NaN, mrec = null            // the chunk the flood is marking into

  function levelOf(level) {
    let L = levels.get(level)
    if (!L) { L = { chunks: new Map(), pins: new Map(), ways: [], arrived: null, walked: 0 }; levels.set(level, L) }
    return L
  }

  function chunkRec(L, cx, cy, epochOf) {
    if (L === mL && cx === mcx && cy === mcy) return mrec
    const k = cx + ',' + cy
    let c = L.chunks.get(k)
    const e = epochOf ? epochOf(cx, cy) | 0 : 0
    if (!c) { c = newChunk(cx, cy, e); L.chunks.set(k, c) }
    else if (epochOf && c.epoch !== e) {
      // the building rearranged itself under these strokes: keep them, dim them, and draw what comes next dark
      c.epoch = e; c.faded = true
      if (c.fresh) c.fresh.fill(0); else c.fresh = new Uint8Array(CELL_BYTES)
      c.fb64 = null
      res.smudged = true
    }
    mL = L; mcx = cx; mcy = cy; mrec = c
    return c
  }

  function mark(L, ix, iy, epochOf) {
    const cx = Math.floor(ix / N), cy = Math.floor(iy / N)
    const c = chunkRec(L, cx, cy, epochOf)
    const b = (iy - cy * N) * N + (ix - cx * N)
    const byte = b >> 3, bit = 1 << (b & 7)
    if ((c.bits[byte] & bit) === 0) { c.bits[byte] |= bit; c.b64 = null; L.walked++ }
    if (c.faded && (c.fresh[byte] & bit) === 0) { c.fresh[byte] |= bit; c.fb64 = null }
  }

  function trailPush(x, y) {
    let i = 0
    while (i < trailN && !(trailX[i] === x && trailY[i] === y)) i++
    if (i === trailN && trailN < TRAIL) trailN++
    for (let j = Math.min(i, TRAIL - 1); j > 0; j--) { trailX[j] = trailX[j - 1]; trailY[j] = trailY[j - 1] }
    trailX[0] = x; trailY[0] = y
  }

  // over the cap: forget the chunk farthest (Chebyshev) from the player's chunk
  function capChunks(L, pcx, pcy) {
    while (L.chunks.size > MAX_CHUNKS) {
      let farK = null, farD = -1
      for (const [k, c] of L.chunks) {
        const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cy - pcy))
        if (d > farD) { farD = d; farK = k }
      }
      L.walked -= popcount(L.chunks.get(farK).bits)
      L.chunks.delete(farK)
    }
  }

  function step(level, px, py, radius, floorFn, epochOf = null) {
    const ix = Math.floor(px), iy = Math.floor(py)
    if (level === lastLevel && ix === lastIx && iy === lastIy) return false
    if (level !== lastLevel) trailN = 0
    lastLevel = level; lastIx = ix; lastIy = iy
    const L = levelOf(level)
    const r = Math.min(MAX_R, Math.max(0, radius | 0))
    res.smudged = false
    mL = null; mrec = null
    visited.fill(0)
    let qh = 0, qt = 0
    visited[MAX_R * W + MAX_R] = 1
    queue[qt++] = 0; queue[qt++] = 0
    mark(L, ix, iy, epochOf)                                  // the player's own cell: you are standing on it
    while (qh < qt) {
      const dx = queue[qh++], dy = queue[qh++]
      for (let d = 0; d < 4; d++) {
        const nx = dx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = dy + (d === 2 ? 1 : d === 3 ? -1 : 0)
        if (nx > r || nx < -r || ny > r || ny < -r) continue
        const vi = (ny + MAX_R) * W + (nx + MAX_R)
        if (visited[vi]) continue
        visited[vi] = 1
        if (!floorFn(ix + nx, iy + ny)) continue
        queue[qt++] = nx; queue[qt++] = ny
        mark(L, ix + nx, iy + ny, epochOf)
      }
    }
    mL = null; mrec = null
    trailPush(ix + 0.5, iy + 0.5)
    capChunks(L, Math.floor(ix / N), Math.floor(iy / N))
    return res
  }

  function has(level, wx, wy) {
    const L = levels.get(level)
    if (!L) return false
    const ix = Math.floor(wx), iy = Math.floor(wy)
    const cx = Math.floor(ix / N), cy = Math.floor(iy / N)
    const c = L.chunks.get(cx + ',' + cy)
    if (!c) return false
    const b = (iy - cy * N) * N + (ix - cx * N)
    return (c.bits[b >> 3] >> (b & 7) & 1) === 1
  }

  // the chunk record at (cx, cy) or null: what buildMapView reads instead of has() per cell
  function chunkAt(level, cx, cy) {
    const L = levels.get(level)
    return L ? (L.chunks.get(cx + ',' + cy) ?? null) : null
  }

  // a way you have seen: rec is a decor exit / stair record { key, x, y, kind, target, label }. The same key updates the pin in place,
  // clears lost and the chunk's fade (you are looking at it: it is where you drew it). `epoch`, when given, is the chunk's current epoch.
  function pinWay(level, rec, epoch = null) {
    const L = levelOf(level)
    const cx = Math.floor(rec.x / N), cy = Math.floor(rec.y / N)
    const chunkKey = cx + ',' + cy
    let p = L.pins.get(rec.key)
    if (!p) {
      p = { key: rec.key, t: ++tick, x: rec.x, y: rec.y, type: rec.kind, flag: rec.target ?? null, chunkKey, lost: false, label: rec.label ?? null, target: rec.target ?? null }
      L.pins.set(rec.key, p)
      L.ways.push(p)
    } else {
      p.x = rec.x; p.y = rec.y; p.type = rec.kind; p.chunkKey = chunkKey; p.lost = false
      if (rec.target != null) { p.flag = rec.target; p.target = rec.target }
      if (rec.label != null) p.label = rec.label
    }
    const c = L.chunks.get(chunkKey)
    if (c) {
      if (c.faded) { c.faded = false; c.fresh = null; c.fb64 = null }
      if (epoch != null) c.epoch = epoch | 0
    }
    return p
  }

  // anything else worth a glyph: machines (flag = vended), notes (flag = read), sights, npcs, where you arrived, where it hurt you
  function pinThing(level, key, type, x, y, flag = null) {
    const L = levelOf(level)
    const cx = Math.floor(x / N), cy = Math.floor(y / N)
    let p = L.pins.get(key)
    if (!p) {
      p = { key, t: ++tick, x, y, type, flag, chunkKey: cx + ',' + cy, lost: false, label: null, target: null }
      L.pins.set(key, p)
      if (type === 'hurt') trimHurt(L)
    } else { p.x = x; p.y = y; p.type = type; p.flag = flag; p.chunkKey = cx + ',' + cy }
    if (type === 'arrived' && (!L.arrived || p.t >= L.arrived.t)) L.arrived = p
    return p
  }

  function trimHurt(L) {
    let n = 0
    for (const p of L.pins.values()) if (p.type === 'hurt') n++
    while (n > HURT_KEEP) {
      let oldest = null
      for (const p of L.pins.values()) if (p.type === 'hurt' && (!oldest || p.t < oldest.t)) oldest = p
      L.pins.delete(oldest.key); n--
    }
  }

  // the level's own containers (stable identity from the first ask: the compass watches ways(level).length)
  function pins(level) { return levelOf(level).pins }
  // every cell walked on the floor (the footer's count), kept as a counter so the card never popcounts 400 chunks
  function walked(level) { return levels.get(level)?.walked ?? 0 }
  function ways(level) { return levelOf(level).ways }
  function arrivedPin(level) { return levels.get(level)?.arrived ?? null }

  function countWays(level) {
    counts.down = 0; counts.up = 0; counts.lift = 0; counts.ring = 0
    const L = levels.get(level)
    if (L) for (let i = 0; i < L.ways.length; i++) counts[L.ways[i].type]++
    return counts
  }

  // has the building moved under this chunk since you drew it? (faded already, or the cache's epoch is not the one stored)
  function isStale(level, chunkKey, epochOf) {
    const c = levels.get(level)?.chunks.get(chunkKey)
    if (!c) return false
    if (c.faded) return true
    return !!epochOf && c.epoch !== (epochOf(c.cx, c.cy) | 0)
  }

  function markLost(level, key) {
    const p = levels.get(level)?.pins.get(key)
    if (p) p.lost = true
    return p ?? null
  }

  // on a cell-change tick: a stale way pin within two cells with no way there any more is lost (once); the game says the line
  function checkStale(level, player, nearestWayFn, epochOf) {
    const L = levels.get(level)
    if (!L) return null
    const ix = Math.floor(player.x), iy = Math.floor(player.y)
    for (let i = 0; i < L.ways.length; i++) {
      const p = L.ways[i]
      if (p.lost) continue
      if (Math.abs(Math.floor(p.x) - ix) > 2 || Math.abs(Math.floor(p.y) - iy) > 2) continue
      if (!isStale(level, p.chunkKey, epochOf)) continue
      if (nearestWayFn(p.x, p.y, 2) != null) continue
      p.lost = true
      return p
    }
    return null
  }

  // the last n distinct cell centres you stood in, newest first (a ring of 8; hauntings and containers read it)
  function lastTrail(n) {
    const out = []
    for (let i = 0; i < trailN && i < n; i++) out.push({ x: trailX[i], y: trailY[i] })
    return out
  }

  function exportMap() {
    const out = {}
    for (const [level, L] of levels) {
      if (L.chunks.size === 0 && L.pins.size === 0) continue           // only asked about, never drawn on
      const chunks = {}, fresh = {}, epochs = {}, pinRows = []
      for (const [k, c] of L.chunks) {
        chunks[k] = c.b64 ?? (c.b64 = packBits(c.bits))
        if (c.faded && c.fresh) fresh[k] = c.fb64 ?? (c.fb64 = packBits(c.fresh))
        epochs[k] = c.epoch
      }
      for (const p of L.pins.values()) pinRows.push([p.key, p.type, p.x, p.y, p.flag, p.t, p.lost])
      out[level] = { chunks, fresh, epochs, pins: pinRows }
    }
    return out
  }

  // replaces the map; false when anything had to be refused (that entry is skipped, the rest is kept)
  function importMap(obj) {
    levels.clear()
    lastLevel = null; lastIx = NaN; lastIy = NaN; trailN = 0; tick = 0; mL = null; mrec = null
    if (!obj || typeof obj !== 'object') return false
    let ok = true
    for (const lk of Object.keys(obj)) {
      const level = Number(lk)
      const src = obj[lk]
      if (!Number.isInteger(level) || !src || typeof src !== 'object') { ok = false; continue }
      const L = levelOf(level)
      const chunks = src.chunks ?? {}, fresh = src.fresh ?? {}, epochs = src.epochs ?? {}
      for (const k of Object.keys(chunks)) {
        const m = /^(-?\d+),(-?\d+)$/.exec(k)
        const bits = m ? unpackBits(chunks[k]) : null
        if (!bits) { ok = false; continue }
        const c = newChunk(Number(m[1]), Number(m[2]), Number.isInteger(epochs[k]) ? epochs[k] : 0)
        c.bits = bits
        if (fresh[k] !== undefined) {
          const f = unpackBits(fresh[k])
          if (f) { c.fresh = f; c.faded = true } else ok = false
        }
        L.chunks.set(k, c)
        L.walked += popcount(bits)
      }
      const lvlWays = waysFor(level)
      const rows = Array.isArray(src.pins) ? src.pins : []
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || !Number.isFinite(row[2]) || !Number.isFinite(row[3])) { ok = false; continue }
        const [key, type, x, y, flag = null, t = 0, lost = false] = row
        const p = { key, t: t | 0, x, y, type, flag, chunkKey: Math.floor(x / N) + ',' + Math.floor(y / N), lost: !!lost, label: null, target: null }
        if (isWayKind(type)) {
          p.target = Number.isFinite(flag) ? flag : null
          p.label = lvlWays.find((w) => w.kind === type)?.label ?? null
          L.ways.push(p)
        }
        if (type === 'arrived' && (!L.arrived || p.t >= L.arrived.t)) L.arrived = p
        L.pins.set(key, p)
        if (p.t > tick) tick = p.t
      }
    }
    return ok
  }

  return { step, pinWay, pinThing, has, pins, ways, arrivedPin, countWays, isStale, markLost, checkStale, lastTrail, export: exportMap, import: importMap, chunkAt, walked }
}

// The window the card draws: `cells` x `cells` cells centred on the player's cell. cells / fresh are Int16Array pairs of WINDOW-relative
// (dx, dy); dim[i] = 1 when cells[i] lies in a faded chunk; faded = the faded chunk keys in the window; pins = the pin records in the
// window; counts = { walked (set bits in the window), total (set bits on the floor), down, up, lift, ring }. Pass opts.out to reuse the
// view and its arrays (same size).
export function buildMapView(fog, level, player, opts = {}) {
  const size = opts.cells ?? 56
  const cap = size * size
  let v = opts.out
  if (!v || v.size !== size) {
    v = { ox: 0, oy: 0, size, px: 0, py: 0, angle: 0, cells: new Int16Array(2 * cap), n: 0, dim: new Uint8Array(cap), fresh: new Int16Array(2 * cap), nFresh: 0, faded: new Set(), pins: [], counts: { walked: 0, total: 0, down: 0, up: 0, lift: 0, ring: 0 } }
  }
  const half = size >> 1
  const pix = Math.floor(player.x), piy = Math.floor(player.y)
  v.ox = pix - half; v.oy = piy - half
  v.px = player.x; v.py = player.y; v.angle = player.angle ?? 0
  v.n = 0; v.nFresh = 0
  v.faded.clear()
  v.pins.length = 0

  const c0 = Math.floor(v.ox / N), c1 = Math.floor((v.ox + size - 1) / N)
  const r0 = Math.floor(v.oy / N), r1 = Math.floor((v.oy + size - 1) / N)
  for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
    const c = fog.chunkAt(level, cx, cy)
    if (!c) continue
    if (c.faded) v.faded.add(cx + ',' + cy)
    const bx = cx * N - v.ox, by = cy * N - v.oy                 // chunk origin in window coordinates
    const lx0 = Math.max(0, -bx), lx1 = Math.min(N - 1, size - 1 - bx)
    const ly0 = Math.max(0, -by), ly1 = Math.min(N - 1, size - 1 - by)
    for (let ly = ly0; ly <= ly1; ly++) for (let lx = lx0; lx <= lx1; lx++) {
      const b = ly * N + lx
      const byte = b >> 3, bit = 1 << (b & 7)
      if (c.bits[byte] & bit) {
        v.cells[2 * v.n] = bx + lx; v.cells[2 * v.n + 1] = by + ly
        v.dim[v.n] = c.faded ? 1 : 0
        v.n++
      }
      if (c.faded && (c.fresh[byte] & bit)) {
        v.fresh[2 * v.nFresh] = bx + lx; v.fresh[2 * v.nFresh + 1] = by + ly
        v.nFresh++
      }
    }
  }
  const allPins = fog.pins(level)
  for (const p of allPins.values()) {
    const dx = Math.floor(p.x) - v.ox, dy = Math.floor(p.y) - v.oy
    if (dx >= 0 && dx < size && dy >= 0 && dy < size) v.pins.push(p)
  }

  const cw = fog.countWays(level)
  v.counts.walked = v.n; v.counts.total = fog.walked(level)
  v.counts.down = cw.down; v.counts.up = cw.up; v.counts.lift = cw.lift; v.counts.ring = cw.ring
  return v
}
