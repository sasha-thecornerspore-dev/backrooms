export const DEFAULT_CONFIG = {
  palette: { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
  fogDistance: 16,
  wallDensity: 0.30,
  chunkEvictRadius: 3,
  flicker: { rate: 0.07, depth: 0.60, recoverySpeed: 12 },
  audio: { humFrequency: 120, droneFrequency: 60, distantEventInterval: [8, 28] },
  // office-maze knobs (see generateChunk): rooms carved out of a loopy corridor grid
  maze: { salt: 0x0000, roomChance: 0.16, braid: 0.12, corridor: 1 },
  // generative weirdcore music bed (audio.js) — levels override per mood
  music: { root: 220, scale: [0, 2, 4, 7, 9], progressions: [[0, 3, 4, 2], [0, 2, 3, 4]], tempo: 440,
           beatsPerChord: 8, beatsPerBar: 4, groove: 0.5, arpLen: 0.5, leadChance: 0.35,
           brightness: 1300, wobble: 0.008, bend: 0.12, noteLen: 1.5, volume: 0.06 },
  lights: true,
  messages: [
    "you shouldn't be here.",
    "the carpet is damp.",
    "the lights don't turn off.",
    "something moved. in your peripheral vision.",
    "you've been walking for hours. days. weeks.",
    "there is no exit.",
    "you can hear something. it's getting closer.",
    "the humming never stops.",
    "level 0.",
    "the wallpaper is the same in every direction.",
  ],
  messageInterval: [25, 90],
  items: { density: 5, types: ['almond-water', 'glowstick', 'polaroid', 'radio'] },
  props: { density: 3, types: ['chair', 'cabinet', 'box', 'cone', 'papers', 'plant'] },
  // found notes left by earlier wanderers — 1-in-`denom` chunks holds a scrap
  scraps: { denom: 7 },
  // vending machines — rarer than notes; 1-in-`denom` chunks holds one
  machines: { denom: 20 },
  // landmark set-pieces — the rarest; a memorable sight to orient by
  sights: { denom: 28 },
  particles: { count: 45, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 },
}

export async function loadConfig() {
  try {
    const r = await fetch('./world.json')
    if (!r.ok) return DEFAULT_CONFIG
    // merge over defaults so a drifted world.json missing a key can't break the engine
    return { ...DEFAULT_CONFIG, ...(await r.json()) }
  } catch {
    return DEFAULT_CONFIG
  }
}

export const CHUNK_SIZE = 22

function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return h ^ (h >>> 16)
}

function normalizeMaze(opts) {
  // Accept a bare density number (legacy/test usage) or a maze options object.
  const o = (typeof opts === 'number') ? { density: opts } : (opts || {})
  return {
    salt:       o.salt | 0,
    roomChance: o.roomChance ?? 0.16,
    braid:      o.braid ?? 0.12,
    corridor:   o.corridor ?? 1,
  }
}

// Generate one chunk as a tight OFFICE MAZE rather than an open cave:
//   • a randomised-DFS corridor grid over a lattice of nodes (1-cell walls),
//   • some walls knocked through ("braid") so it loops like a real building,
//   • some nodes expanded into small rooms,
//   • a guaranteed central cross hallway (full mid row + mid column) that also
//     provides the always-open border passages adjacent chunks connect through.
//
// Invariants (relied on by world.test.js and by cross-chunk navigation):
//   - deterministic in (cx, cy, epoch, salt)
//   - the entire midpoint row is open, and the four border midpoints are open
//   - every cell is 0 (floor) or 1 (wall)
export function generateChunk(cx, cy, epoch, opts = {}) {
  const o    = normalizeMaze(opts)
  const N    = CHUNK_SIZE
  const m     = N >> 1
  const seed  = (hash2(hash2(cx, cy), Math.imul(epoch, 2654435761) | 0) ^ (o.salt | 0)) >>> 0
  const rnd   = mulberry32(seed)
  const cell  = new Uint8Array(N * N).fill(1)   // start fully solid, then carve

  const idx  = (x, y) => y * N + x
  const open = (x, y) => { if (x >= 0 && x < N && y >= 0 && y < N) cell[idx(x, y)] = 0 }

  // Node lattice: nodes sit on odd interior cells 1,3,…,N-3 (walls on even cells).
  const NN       = Math.floor((N - 2) / 2)     // nodes per axis
  const nodeCell = (i) => 1 + 2 * i

  // ── randomised DFS carves a spanning maze over the node grid ──
  const visited = new Uint8Array(NN * NN)
  const stack   = []
  const sc      = NN >> 1
  let cur = sc * NN + sc
  visited[cur] = 1
  open(nodeCell(cur % NN), nodeCell((cur / NN) | 0))
  stack.push(cur)
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  while (stack.length) {
    cur = stack[stack.length - 1]
    const nx0 = cur % NN, ny0 = (cur / NN) | 0
    const nb = []
    for (const [dx, dy] of DIRS) {
      const nx = nx0 + dx, ny = ny0 + dy
      if (nx >= 0 && nx < NN && ny >= 0 && ny < NN && !visited[ny * NN + nx]) nb.push([nx, ny])
    }
    if (nb.length === 0) { stack.pop(); continue }
    const [nx, ny] = nb[(rnd() * nb.length) | 0]
    const cx0 = nodeCell(nx0), cy0 = nodeCell(ny0), cx1 = nodeCell(nx), cy1 = nodeCell(ny)
    open(cx1, cy1)
    open((cx0 + cx1) >> 1, (cy0 + cy1) >> 1)     // the wall cell between the two nodes
    visited[ny * NN + nx] = 1
    stack.push(ny * NN + nx)
  }

  // ── braid: reopen some inter-node walls so the floor loops like a building ──
  for (let ny = 0; ny < NN; ny++) {
    for (let nx = 0; nx < NN; nx++) {
      if (nx + 1 < NN && rnd() < o.braid) open((nodeCell(nx) + nodeCell(nx + 1)) >> 1, nodeCell(ny))
      if (ny + 1 < NN && rnd() < o.braid) open(nodeCell(nx), (nodeCell(ny) + nodeCell(ny + 1)) >> 1)
    }
  }

  // ── rooms: expand some nodes into small open rooms (offices, storerooms) ──
  for (let ny = 0; ny < NN; ny++) {
    for (let nx = 0; nx < NN; nx++) {
      if (rnd() < o.roomChance) {
        const cxn = nodeCell(nx), cyn = nodeCell(ny)
        const rw = rnd() < 0.22 ? 2 : 1
        for (let yy = cyn - rw; yy <= cyn + rw; yy++)
          for (let xx = cxn - rw; xx <= cxn + rw; xx++)
            if (xx >= 1 && xx < N - 1 && yy >= 1 && yy < N - 1) open(xx, yy)
      }
    }
  }

  // ── central cross hallway — the main hall, and the chunk's border passages ──
  for (let y = 0; y < N; y++) open(m, y)
  for (let x = 0; x < N; x++) open(x, m)

  // ── a small clear room at the world origin so you never spawn in a wall ──
  if (cx === 0 && cy === 0) {
    for (let yy = m - 2; yy <= m + 2; yy++)
      for (let xx = m - 2; xx <= m + 2; xx++)
        open(xx, yy)
  }

  return cell
}

// How many chunks the cache keeps before it forgets any: the whole keep zone at the default radius (everything within evictRadius + 2 of the
// player is an 11x11 block = 121 chunks), so the building forgets only what is genuinely behind you. decor.js / items.js / entities.js drop
// their records at the same evictRadius + 2, so no subsystem ever holds a record (a remembered exit, a creature's chunk) on a chunk the cache
// has regenerated under a new epoch.
export const MAX_RESIDENT = 121

export function createChunkCache(config, fixedSeed = null) {
  // Accept either a config object or a bare evictRadius number (legacy/test usage)
  const evictRadius = (typeof config === 'object' && config !== null)
    ? (config.chunkEvictRadius ?? 3)
    : (config ?? 3)
  // Maze options: prefer config.maze, else fall back to a legacy wallDensity number.
  const mazeOpts = (typeof config === 'object' && config !== null)
    ? (config.maze ?? { density: config.wallDensity ?? 0.30 })
    : { density: 0.30 }

  const chunks = new Map()  // "cx,cy" → Uint8Array
  const epochs = new Map()  // "cx,cy" → eviction count

  function key(cx, cy) { return `${cx},${cy}` }

  // Forget only past the cap, and only chunks beyond the keep zone the other subsystems use (Chebyshev > evictRadius + 2: decor.js:130,
  // items.js:67, entities.js:68). This is a superset of gfx-world.js memoSafe's contract (evicts only chunks more than evictRadius away).
  function evict(pcx, pcy) {
    if (chunks.size <= MAX_RESIDENT) return
    const keep = evictRadius + 2
    for (const [k] of chunks) {
      const [ex, ey] = k.split(',').map(Number)
      if (Math.max(Math.abs(ex - pcx), Math.abs(ey - pcy)) > keep) {
        if (fixedSeed === null) {
          epochs.set(k, (epochs.get(k) ?? 0) + 1)
        }
        chunks.delete(k)
      }
    }
  }

  // How many times (cx, cy) has been forgotten and regenerated — 0 for a fresh chunk, always 0 under a fixed seed (layouts never change).
  function epochOf(cx, cy) { return epochs.get(key(cx, cy)) ?? 0 }

  function getChunk(cx, cy, playerCx = cx, playerCy = cy) {
    const k = key(cx, cy)
    if (!chunks.has(k)) {
      const epoch = fixedSeed !== null ? fixedSeed : (epochs.get(k) ?? 0)
      const chunk = generateChunk(cx, cy, epoch, mazeOpts)
      chunks.set(k, chunk)
      evict(playerCx, playerCy)
      // Return the chunk we just generated — evict() may have removed it from the
      // map again if it lies beyond the evict radius (e.g. a far-wandering entity
      // checking walls). Reading chunks.get(k) here could yield undefined and, one
      // frame later, crash isWall on `undefined[i]` and freeze the render loop.
      return chunk
    }
    return chunks.get(k)
  }

  function isWall(wx, wy, playerCx, playerCy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    const cx = Math.floor(ix / CHUNK_SIZE)
    const cy = Math.floor(iy / CHUNK_SIZE)
    const lx = ((ix % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    const ly = ((iy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    return getChunk(cx, cy, playerCx ?? cx, playerCy ?? cy)[ly * CHUNK_SIZE + lx] === 1
  }

  function preload(pcx, pcy) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        getChunk(pcx + dx, pcy + dy, pcx, pcy)
  }

  return { getChunk, isWall, preload, epochOf }
}

// The grid the hot paths read (hunt perception, fog, LOS, collision): floor(ix, iy) -> true when the integer cell is open. It keeps the last
// (cx, cy, Uint8Array) and asks cache.getChunk(cx, cy, pcx, pcy) only when the cell crosses a chunk border, indexing the array otherwise —
// cache.isWall builds a key string per call, which a few hundred asks a frame cannot afford. setPlayerChunk(pcx, pcy) is the chunk the
// cache evicts relative to (set it each frame before the subsystems run). Without a getChunk (createFixedMap: Level ∅) it wraps
// isWallFn at the cell centre.
export function createGridReader(cache, isWallFn) {
  let pcx = 0, pcy = 0
  function setPlayerChunk(x, y) { pcx = x; pcy = y }
  if (!cache || typeof cache.getChunk !== 'function') {
    return { floor: (ix, iy) => !isWallFn(ix + 0.5, iy + 0.5), setPlayerChunk }
  }
  const N = CHUNK_SIZE
  let ccx = NaN, ccy = NaN, cells = null                       // NaN: the first ask always loads
  function floor(ix, iy) {
    const cx = Math.floor(ix / N), cy = Math.floor(iy / N)
    if (cx !== ccx || cy !== ccy) { ccx = cx; ccy = cy; cells = cache.getChunk(cx, cy, pcx, pcy) }
    return cells[(iy - cy * N) * N + (ix - cx * N)] === 0
  }
  return { floor, setPlayerChunk }
}
