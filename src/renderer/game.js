import { loadConfig, CHUNK_SIZE, createChunkCache } from './world.js'
import { createEntitySystem } from './entities.js'
import { createItemSystem } from './items.js'
import { createRenderer } from './renderer.js'
import { initAudio, setFlicker, setRadio } from './audio.js'
import { formatAnchor, driftMeters } from './anchor.js'

// Presence: 1 in 12 chunks has a spirit at its midpoint
function chunkHasPresence(cx, cy) {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xFF) % 12 === 0
}

const ITEM_NAMES = {
  'almond-water': 'almond water',
  'glowstick':    'glowstick',
  'polaroid':     'polaroid camera',
  'radio':        'radio',
}

export async function initGame(canvas, { worldSeed = null, mpClient = null, anchor = null } = {}) {
  const config = await loadConfig()
  const cache  = createChunkCache(config, worldSeed)
  const entitySys = createEntitySystem(config, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
  const itemSys   = createItemSystem(config, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
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
  const spawnX = player.x, spawnY = player.y

  // Flicker state
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0

  // Effect timers
  let stamina    = 100
  let calmTimer  = 0   // almond water — lights hold steady
  let fogTimer   = 0   // glowstick — fog pushed back
  let radioWasOn = false

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
    let text = `level 0 — zone ${pcx},${pcy}`
    if (anchor) {
      text += `\nanchor ${formatAnchor(anchor)} · drift ${driftMeters(player.x, player.y, spawnX, spawnY)}m`
    }
    hudEl.textContent = text
  }

  // Stamina bar
  const stamWrap = document.getElementById('stamina-wrap')
  const stamFill = document.getElementById('stamina-fill')
  function updateStamina() {
    if (!stamWrap || !stamFill) return
    stamWrap.style.opacity = stamina < 99.5 ? '1' : '0'
    stamFill.style.width = `${Math.max(0, Math.min(100, stamina))}%`
  }

  // Hotbar
  const hotbarEl = document.getElementById('hotbar')
  function renderHotbar() {
    if (!hotbarEl) return
    let html = ''
    for (let i = 0; i < 6; i++) {
      const item = itemSys.inventory[i]
      const sel = i === itemSys.selected ? ' sel' : ''
      const label = item ? (ITEM_NAMES[item.type] ?? item.type).split(' ')[0] + (item.on ? ' ♪' : '') : ''
      html += `<div class="slot${sel}"><span class="num">${i + 1}</span>${label}</div>`
    }
    hotbarEl.innerHTML = html
  }
  renderHotbar()

  // Messages
  const msgEl  = document.getElementById('msg')
  let msgTimer = 0
  let msgNext  = config.messageInterval[0] + Math.random() * (config.messageInterval[1] - config.messageInterval[0])
  const messages = anchor
    ? [...config.messages,
       `your body remains at ${formatAnchor(anchor)}.`,
       'you are very far from your body now.',
       'somewhere above, it is still daytime where you fell.']
    : config.messages

  function showMessage(text) {
    if (!msgEl) return
    msgEl.textContent = text
    msgEl.style.color = 'rgba(200,185,90,0.75)'
    setTimeout(() => { msgEl.style.color = 'rgba(200,185,90,0)' }, 4000)
  }

  // Polaroid flash overlay
  const flashEl = document.getElementById('flash')
  function firePolaroid() {
    // capture before the flash washes anything out
    let dataUrl = null
    try { dataUrl = canvas.toDataURL('image/png') } catch { /* ignore */ }
    if (flashEl) {
      flashEl.style.transition = 'none'
      flashEl.style.opacity = '0.9'
      requestAnimationFrame(() => {
        flashEl.style.transition = 'opacity 1.2s'
        flashEl.style.opacity = '0'
      })
    }
    if (dataUrl && window.backrooms?.savePhoto) {
      window.backrooms.savePhoto(dataUrl)
        .then(p => showMessage(p ? 'evidence captured.' : 'the film is blank.'))
        .catch(() => showMessage('the film is blank.'))
    } else {
      showMessage('the film is blank.')
    }
  }

  function applyItemEffect(eff) {
    if (!eff) return
    if (eff.type === 'almond-water') {
      stamina = 100
      calmTimer = 20
      showMessage('the water is sweet. the lights steady.')
    } else if (eff.type === 'glowstick') {
      fogTimer = 45
      showMessage('green light pushes at the dark.')
    } else if (eff.type === 'polaroid') {
      firePolaroid()
    } else if (eff.type === 'radio') {
      showMessage(eff.on ? 'the radio crackles to life.' : 'the radio falls silent.')
    }
    renderHotbar()
  }

  let last = 0
  function loop(ts) {
    const dt = Math.min((ts - last) / 1000, 0.05)
    last = ts

    // ── Flicker ──
    flickTimer -= dt
    if (calmTimer > 0) {
      calmTimer -= dt
      flickTgt = 0.97
    } else if (flickTimer <= 0) {
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
    const wantSprint = (K['ShiftLeft'] || K['ShiftRight']) && stamina > 0
    const mult = wantSprint ? 1.8 : 1
    const sp = SPEED * dt * 60 * mult
    const ca = Math.cos(player.angle), sa = Math.sin(player.angle)
    let moved = false

    if (K['KeyW'] || K['ArrowUp'])    { tryMove(player.x + ca * sp,                         player.y + sa * sp);                         moved = true }
    if (K['KeyS'] || K['ArrowDown'])  { tryMove(player.x - ca * sp * 0.6,                   player.y - sa * sp * 0.6);                   moved = true }
    if (K['KeyA'])                    { tryMove(player.x + Math.cos(player.angle - Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle - Math.PI/2) * sp * 0.7); moved = true }
    if (K['KeyD'])                    { tryMove(player.x + Math.cos(player.angle + Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle + Math.PI/2) * sp * 0.7); moved = true }
    if (!locked && K['ArrowLeft'])  player.angle -= 0.04
    if (!locked && K['ArrowRight']) player.angle += 0.04

    // stamina drains only while actually sprinting somewhere
    if (moved && wantSprint) stamina = Math.max(0, stamina - 22 * dt)
    else                     stamina = Math.min(100, stamina + 9 * dt)

    player.moving = moved
    if (moved) player.bob += 0.12 * mult
    player.bobOffset = moved ? Math.sin(player.bob) * 4 : 0

    // effect timers
    if (fogTimer > 0) fogTimer -= dt
    const fogMul = fogTimer > 0 ? 1.6 : 1

    msgTimer += dt
    if (msgTimer >= msgNext) {
      msgTimer = 0
      msgNext  = config.messageInterval[0] + Math.random() * (config.messageInterval[1] - config.messageInterval[0])
      const pick = messages[Math.floor(Math.random() * messages.length)]
      showMessage(pick)
    }
    updateHud()
    updateStamina()

    const radioOn = itemSys.isRadioOn()
    if (radioOn !== radioWasOn) {
      radioWasOn = radioOn
      setRadio(radioOn)
    }

    // Presence proximity check — the radio finds them from much farther away
    const pcxP = Math.floor(player.x / CHUNK_SIZE)
    const pcyP = Math.floor(player.y / CHUNK_SIZE)
    const presenceRange = radioOn ? 400 : 4
    let nearPresence = false
    for (let dy = -1; dy <= 1 && !nearPresence; dy++) {
      for (let dx = -1; dx <= 1 && !nearPresence; dx++) {
        const cx = pcxP + dx, cy = pcyP + dy
        if (!chunkHasPresence(cx, cy)) continue
        const px2 = cx * CHUNK_SIZE + CHUNK_SIZE / 2
        const py2 = cy * CHUNK_SIZE + CHUNK_SIZE / 2
        const dist2 = (player.x - px2) ** 2 + (player.y - py2) ** 2
        if (dist2 < presenceRange) nearPresence = true
      }
    }
    const hintEl = document.getElementById('presence-hint')
    if (hintEl) hintEl.style.opacity = nearPresence ? '1' : '0'

    // Items — pickup hint + F to take
    const nearItem = itemSys.nearestItem(player.x, player.y, 1.4)
    const itemHintEl = document.getElementById('item-hint')
    if (itemHintEl) {
      if (nearItem) {
        itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}`
        itemHintEl.style.opacity = '1'
      } else {
        itemHintEl.style.opacity = '0'
      }
    }
    if (K['KeyF'] && nearItem && !dialogOpen) {
      K['KeyF'] = false
      const res = itemSys.pickUp(nearItem.key)
      if (res.ok) showMessage(`you take the ${ITEM_NAMES[res.item.type] ?? res.item.type}.`)
      else if (res.reason === 'full') showMessage('your hands are full.')
      renderHotbar()
    }

    // Q uses the selected item; 1–6 select slots
    if (K['KeyQ'] && !dialogOpen) {
      K['KeyQ'] = false
      applyItemEffect(itemSys.useSelected())
    }
    if (!dialogOpen) {
      for (let i = 0; i < 6; i++) {
        const code = `Digit${i + 1}`
        if (K[code]) {
          K[code] = false
          itemSys.select(i)
          renderHotbar()
        }
      }
    }

    // E-key / ESC dialog control
    if (K['KeyE'] && nearPresence && !dialogOpen) { K['KeyE'] = false; openDialog() }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // Pre-load chunks around current position
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)

    // send our position to server
    if (mpClient?.isConnected()) {
      mpClient.sendPos(player.x, player.y, player.angle)
    }

    // Entities update before render so positions are current this frame
    entitySys.update(dt, player, pcx, pcy, radioOn ? 1.5 : 1)

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
    const itemEntities = itemSys.getWorldItems().map(it => ({
      x: it.x, y: it.y, kind: 'item', itemType: it.type,
    }))
    const allEntities = [...entitySys.getEntities(), ...remoteEntities, ...itemEntities]

    gfx.render(player, (wx, wy) => cache.isWall(wx, wy, pcx, pcy), flicker, allEntities, fogMul)

    requestAnimationFrame(loop)
  }

  requestAnimationFrame(loop)
}
