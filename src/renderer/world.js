export const DEFAULT_CONFIG = {
  palette: { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
  fogDistance: 16,
  wallDensity: 0.30,
  chunkEvictRadius: 3,
  flicker: { rate: 0.07, depth: 0.60, recoverySpeed: 12 },
  audio: { humFrequency: 120, droneFrequency: 60, distantEventInterval: [8, 28] },
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
}

export async function loadConfig() {
  try {
    const r = await fetch('./world.json')
    if (!r.ok) return DEFAULT_CONFIG
    return await r.json()
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

export function generateChunk(cx, cy, epoch) {
  const seed = hash2(hash2(cx, cy), Math.imul(epoch, 2654435761) | 0)
  const rnd  = mulberry32(seed)
  const cell = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)

  // Random fill
  for (let i = 0; i < cell.length; i++) cell[i] = rnd() > 0.70 ? 1 : 0

  // Cellular automata smoothing — 3 passes, Moore neighbourhood, threshold 5
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Uint8Array(cell)
    for (let y = 1; y < CHUNK_SIZE - 1; y++) {
      for (let x = 1; x < CHUNK_SIZE - 1; x++) {
        let w = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            w += cell[(y + dy) * CHUNK_SIZE + (x + dx)]
        tmp[y * CHUNK_SIZE + x] = w >= 5 ? 1 : 0
      }
    }
    cell.set(tmp)
  }

  // Forced cross-corridors at chunk midpoints (3 cells wide)
  const m = CHUNK_SIZE >> 1
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let w = -1; w <= 1; w++) {
      const x = m + w
      if (x >= 0 && x < CHUNK_SIZE) cell[y * CHUNK_SIZE + x] = 0
    }
  }
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let w = -1; w <= 1; w++) {
      const y = m + w
      if (y >= 0 && y < CHUNK_SIZE) cell[y * CHUNK_SIZE + x] = 0
    }
  }

  // Random pillars in corridors for visual depth
  const rnd2 = mulberry32(seed ^ 0xDEAD0000)
  for (let y = 4; y < CHUNK_SIZE - 4; y++) {
    for (let x = 4; x < CHUNK_SIZE - 4; x++) {
      const onH = Math.abs(x - m) <= 1
      const onV = Math.abs(y - m) <= 1
      if ((onH || onV) && rnd2() > 0.91) cell[y * CHUNK_SIZE + x] = 1
    }
  }

  // Re-clear cross-corridors after pillar pass to ensure full rows/cols are open
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let w = -1; w <= 1; w++) {
      const x = m + w
      if (x >= 0 && x < CHUNK_SIZE) cell[y * CHUNK_SIZE + x] = 0
    }
  }
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let w = -1; w <= 1; w++) {
      const y = m + w
      if (y >= 0 && y < CHUNK_SIZE) cell[y * CHUNK_SIZE + x] = 0
    }
  }

  // Open 3-cell passages at chunk borders (ensures cross-chunk navigation)
  for (let w = -1; w <= 1; w++) {
    const lx = m + w, ly = m + w
    if (lx >= 0 && lx < CHUNK_SIZE) {
      cell[0 * CHUNK_SIZE + lx] = 0
      cell[1 * CHUNK_SIZE + lx] = 0
      cell[(CHUNK_SIZE - 1) * CHUNK_SIZE + lx] = 0
      cell[(CHUNK_SIZE - 2) * CHUNK_SIZE + lx] = 0
    }
    if (ly >= 0 && ly < CHUNK_SIZE) {
      cell[ly * CHUNK_SIZE + 0] = 0
      cell[ly * CHUNK_SIZE + 1] = 0
      cell[ly * CHUNK_SIZE + CHUNK_SIZE - 1] = 0
      cell[ly * CHUNK_SIZE + CHUNK_SIZE - 2] = 0
    }
  }

  // Clear spawn area for origin chunk
  if (cx === 0 && cy === 0 && epoch === 0) {
    for (let y = m - 3; y <= m + 3; y++)
      for (let x = m - 3; x <= m + 3; x++)
        if (y >= 0 && y < CHUNK_SIZE && x >= 0 && x < CHUNK_SIZE)
          cell[y * CHUNK_SIZE + x] = 0
  }

  return cell
}

export function createChunkCache(evictRadius) {
  const chunks = new Map()  // "cx,cy" → Uint8Array
  const epochs = new Map()  // "cx,cy" → eviction count

  function key(cx, cy) { return `${cx},${cy}` }

  function evict(pcx, pcy) {
    if (chunks.size <= 49) return
    for (const [k] of chunks) {
      const [ex, ey] = k.split(',').map(Number)
      if (Math.max(Math.abs(ex - pcx), Math.abs(ey - pcy)) > evictRadius) {
        epochs.set(k, (epochs.get(k) ?? 0) + 1)
        chunks.delete(k)
      }
    }
  }

  function getChunk(cx, cy) {
    const k = key(cx, cy)
    if (!chunks.has(k)) {
      chunks.set(k, generateChunk(cx, cy, epochs.get(k) ?? 0))
      const pcx = cx, pcy = cy
      evict(pcx, pcy)
    }
    return chunks.get(k)
  }

  function isWall(wx, wy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    const cx = Math.floor(ix / CHUNK_SIZE)
    const cy = Math.floor(iy / CHUNK_SIZE)
    const lx = ((ix % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    const ly = ((iy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    return getChunk(cx, cy)[ly * CHUNK_SIZE + lx] === 1
  }

  function preload(pcx, pcy) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        getChunk(pcx + dx, pcy + dy)
  }

  return { getChunk, isWall, preload }
}
