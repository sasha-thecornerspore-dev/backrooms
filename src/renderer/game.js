import { loadConfig, CHUNK_SIZE, createChunkCache } from './world.js'
import { createEntitySystem } from './entities.js'
import { createRenderer } from './renderer.js'
import { initAudio, setFlicker } from './audio.js'

// Presence: 1 in 12 chunks has a spirit at its midpoint
function chunkHasPresence(cx, cy) {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xFF) % 12 === 0
}

export async function initGame(canvas, { worldSeed = null, mpClient = null } = {}) {
  const config = await loadConfig()
  const cache  = createChunkCache(config, worldSeed)
  const entitySys = createEntitySystem(config, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
  const gfx    = createRenderer(canvas, config)

  // Pre-load chunks around spawn
  const spawnCX = 0, spawnCY = 0
  cache.preload(spawnCX, spawnCY)
  initAudio(config)

  // Player state — spawns at chunk midpoint
  const HALF = CHUNK_SIZE / 2
  const player = {
    x: HALF + 0.5,
    y: HALF + 0.5,
    angle: 0,
    bob: 0,
    bobOffset: 0,
    moving: false,
  }

  // Flicker state
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0

  // Input
  const K = Object.create(null)
  let locked = false

  window.addEventListener('keydown', e => { K[e.code] = true })
  window.addEventListener('keyup',   e => { K[e.code] = false })

  canvas.addEventListener('click', () => canvas.requestPointerLock())
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas
  })
  document.addEventListener('mousemove', e => {
    if (locked) player.angle += e.movementX * 0.002
  })

  // Wish dialog
  let dialogOpen = false
  const dialogEl = document.getElementById('wish-dialog')
  const wishText = document.getElementById('wish-text')
  const wishResp = document.getElementById('wish-response')

  function openDialog() {
    if (dialogOpen) return
    dialogOpen = true
    document.exitPointerLock()
    if (dialogEl) { dialogEl.style.display = 'flex'; wishText.value = ''; wishResp.textContent = ''; wishText.focus() }
  }

  function closeDialog() {
    dialogOpen = false
    if (dialogEl) dialogEl.style.display = 'none'
  }

  document.getElementById('wish-cancel')?.addEventListener('click', closeDialog)

  document.getElementById('wish-submit')?.addEventListener('click', async () => {
    const text = wishText?.value.trim()
    if (!text) return
    if (wishResp) wishResp.textContent = 'your request has been received. whether it is heard is another matter.'
    wishText.disabled = true
    document.getElementById('wish-submit').disabled = true
    try {
      if (window.backrooms?.submitWish) await window.backrooms.submitWish(text)
    } catch (e) { /* silent */ }
    setTimeout(() => {
      wishText.disabled = false
      document.getElementById('wish-submit').disabled = false
      closeDialog()
    }, 3000)
  })

  // Resize
  function resize() {
    canvas.width  = window.innerWidth
    canvas.height = window.innerHeight
  }
  window.addEventListener('resize', resize)
  resize()

  const SPEED = 0.05

  function tryMove(nx, ny) {
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    if (!cache.isWall(nx, player.y, pcx, pcy)) player.x = nx
    if (!cache.isWall(player.x, ny, pcx, pcy)) player.y = ny
  }

  // HUD
  const hudEl = document.getElementById('hud')
  function updateHud() {
    if (!hudEl) return
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    hudEl.textContent = `level 0 — zone ${pcx},${pcy}`
  }

  // Messages
  const msgEl  = document.getElementById('msg')
  let msgTimer = 0
  let msgNext  = config.messageInterval[0] + Math.random() * (config.messageInterval[1] - config.messageInterval[0])

  function showMessage(text) {
    if (!msgEl) return
    msgEl.textContent = text
    msgEl.style.color = 'rgba(200,185,90,0.75)'
    setTimeout(() => { msgEl.style.color = 'rgba(200,185,90,0)' }, 4000)
  }

  let last = 0
  function loop(ts) {
    const dt = Math.min((ts - last) / 1000, 0.05)
    last = ts

    // ── Flicker ──
    flickTimer -= dt
    if (flickTimer <= 0) {
      if (Math.random() < config.flicker.rate) {
        flickTgt   = 1 - config.flicker.depth * Math.random()
        flickTimer = 0.04 + Math.random() * 0.12
      } else {
        flickTgt   = 0.92 + Math.random() * 0.08
        flickTimer = 0.8  + Math.random() * 3
      }
    }
    flicker += (flickTgt - flicker) * Math.min(1, dt * config.flicker.recoverySpeed)
    setFlicker(flicker)

    // ── Movement ──
    const sp = SPEED * dt * 60
    const ca = Math.cos(player.angle), sa = Math.sin(player.angle)
    let moved = false

    if (K['KeyW'] || K['ArrowUp'])    { tryMove(player.x + ca * sp,                         player.y + sa * sp);                         moved = true }
    if (K['KeyS'] || K['ArrowDown'])  { tryMove(player.x - ca * sp * 0.6,                   player.y - sa * sp * 0.6);                   moved = true }
    if (K['KeyA'])                    { tryMove(player.x + Math.cos(player.angle - Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle - Math.PI/2) * sp * 0.7); moved = true }
    if (K['KeyD'])                    { tryMove(player.x + Math.cos(player.angle + Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle + Math.PI/2) * sp * 0.7); moved = true }
    if (!locked && K['ArrowLeft'])  player.angle -= 0.04
    if (!locked && K['ArrowRight']) player.angle += 0.04

    player.moving = moved
    if (moved) player.bob += 0.12
    player.bobOffset = moved ? Math.sin(player.bob) * 4 : 0

    msgTimer += dt
    if (msgTimer >= msgNext) {
      msgTimer = 0
      msgNext  = config.messageInterval[0] + Math.random() * (config.messageInterval[1] - config.messageInterval[0])
      const pick = config.messages[Math.floor(Math.random() * config.messages.length)]
      showMessage(pick)
    }
    updateHud()

    // Presence proximity check
    const pcxP = Math.floor(player.x / CHUNK_SIZE)
    const pcyP = Math.floor(player.y / CHUNK_SIZE)
    let nearPresence = false
    for (let dy = -1; dy <= 1 && !nearPresence; dy++) {
      for (let dx = -1; dx <= 1 && !nearPresence; dx++) {
        const cx = pcxP + dx, cy = pcyP + dy
        if (!chunkHasPresence(cx, cy)) continue
        const px2 = cx * CHUNK_SIZE + CHUNK_SIZE / 2
        const py2 = cy * CHUNK_SIZE + CHUNK_SIZE / 2
        const dist2 = (player.x - px2) ** 2 + (player.y - py2) ** 2
        if (dist2 < 4) nearPresence = true
      }
    }
    const hintEl = document.getElementById('presence-hint')
    if (hintEl) hintEl.style.opacity = nearPresence ? '1' : '0'

    // E-key / ESC dialog control
    if (K['KeyE'] && nearPresence && !dialogOpen) { K['KeyE'] = false; openDialog() }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // Pre-load chunks around current position
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    cache.preload(pcx, pcy)

    // send our position to server
    if (mpClient?.isConnected()) {
      mpClient.sendPos(player.x, player.y, player.angle)
    }

    // Entities update before render so positions are current this frame
    entitySys.update(dt, player, pcx, pcy)

    // merge remote players into entity list for rendering
    const remoteEntities = mpClient
      ? mpClient.getRemotePlayers().map(p => ({
          x: p.x, y: p.y,
          type: 'stalker', state: 'chase',
          dir: 0, dirTimer: 0,
          chunkCx: Math.floor(p.x / CHUNK_SIZE),
          chunkCy: Math.floor(p.y / CHUNK_SIZE),
        }))
      : []
    const allEntities = [...entitySys.getEntities(), ...remoteEntities]

    gfx.render(player, (wx, wy) => cache.isWall(wx, wy, pcx, pcy), flicker, allEntities)

    requestAnimationFrame(loop)
  }

  requestAnimationFrame(loop)
}
