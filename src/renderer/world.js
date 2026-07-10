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
  music: { root: 220, scale: [0, 2, 4, 7, 9], tempo: 640, density: 0.5,
           brightness: 1300, wobble: 0.01, bend: 0.12, chordEvery: 9, noteLen: 1.7, volume: 0.06 },
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

  function evict(pcx, pcy) {
    if (chunks.size <= 49) return
    for (const [k] of chunks) {
      const [ex, ey] = k.split(',').map(Number)
      if (Math.max(Math.abs(ex - pcx), Math.abs(ey - pcy)) > evictRadius) {
        if (fixedSeed === null) {
          epochs.set(k, (epochs.get(k) ?? 0) + 1)
        }
        chunks.delete(k)
      }
    }
  }

  function getChunk(cx, cy, playerCx = cx, playerCy = cy) {
    const k = key(cx, cy)
    if (!chunks.has(k)) {
      const epoch = fixedSeed !== null ? fixedSeed : (epochs.get(k) ?? 0)
      chunks.set(k, generateChunk(cx, cy, epoch, mazeOpts))
      evict(playerCx, playerCy)
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

  return { getChunk, isWall, preload }
}
