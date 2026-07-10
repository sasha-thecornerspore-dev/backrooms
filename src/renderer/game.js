import { loadConfig, CHUNK_SIZE, createChunkCache } from './world.js'
import { levelConfig } from './levels.js'
import { createEntitySystem } from './entities.js'
import { createItemSystem } from './items.js'
import { createDecorSystem } from './decor.js'
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
  'bandage':      'bandage',
  'polaroid':     'polaroid camera',
  'radio':        'radio',
}

export async function initGame(canvas, { worldSeed = null, mpClient = null, anchor = null } = {}) {
  const base = await loadConfig()

  // ── player state — PERSISTS across level transitions (hp + inventory carry) ──
  const HALF = CHUNK_SIZE / 2
  const player = {
    x: HALF + 0.5, y: HALF + 0.5,
    angle: 0, bob: 0, bobOffset: 0, moving: false,
    hp: 100, maxHp: 100,
  }
  let spawnX = player.x, spawnY = player.y

  // inventory lives in itemSys and persists; its wall test reads the CURRENT level
  const itemSys = createItemSystem(base, (wx, wy, pcx, pcy) => level.cache.isWall(wx, wy, pcx, pcy))

  // persistent effect / combat timers
  let stamina    = 100
  let calmTimer  = 0    // almond water — lights hold steady
  let fogTimer   = 0    // glowstick — fog pushed back
  let radioWasOn = false
  let invuln     = 0    // i-frames after a hit
  let hurt       = 0    // red-flash intensity
  let regenDelay = 0    // seconds before hp regen resumes

  // Flicker state (persists; retuned per level via level.cfg.flicker)
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0

  initAudio(base)

  // ── per-level state, rebuilt on every transition ──
  let level = null
  let transitioning = false
  const fadeEl = document.getElementById('fade')

  function buildLevel(index) {
    const cfg   = levelConfig(base, index)
    const cache = createChunkCache(cfg, worldSeed)   // cfg.maze.salt differentiates levels
    cache.preload(0, 0)
    const entitySys = createEntitySystem(cfg, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
    const decor     = createDecorSystem(cfg, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
    const gfx       = createRenderer(canvas, cfg)
    itemSys.enterLevel(cfg)

    // spawn at the origin room (always carved open in world.js)
    player.x = HALF + 0.5; player.y = HALF + 0.5
    spawnX = player.x; spawnY = player.y

    const messages = [
      ...(cfg.messages || []),
      cfg.exit?.hint,
      ...(anchor ? [`your body remains at ${formatAnchor(anchor)}.`, 'you are very far from your body now.'] : []),
    ].filter(Boolean)

    // Assign `level` BEFORE warming up subsystems — itemSys reads level.cache
    // through a proxy, so the object must exist first.
    level = { index, cfg, cache, entitySys, decor, gfx, messages }
    decor.update(0, 0); itemSys.update(0, 0)

    updateHud()
    renderHotbar()
    return level
  }

  function fadeThen(cb) {
    if (!fadeEl) { cb(); return }
    fadeEl.style.transition = 'opacity 0.55s'
    fadeEl.style.opacity = '1'
    setTimeout(() => {
      cb()
      requestAnimationFrame(() => { fadeEl.style.opacity = '0' })
    }, 580)
  }

  function descend(target, label) {
    if (transitioning) return
    transitioning = true
    document.exitPointerLock()
    fadeThen(() => {
      buildLevel(target)
      showMessage(level.cfg.levelName)
      if (level.cfg.exit?.hint) setTimeout(() => showMessage(level.cfg.exit.hint), 3800)
      setTimeout(() => { transitioning = false }, 150)
    })
  }

  function die() {
    if (transitioning) return
    transitioning = true
    document.exitPointerLock()
    fadeThen(() => {
      player.hp = player.maxHp
      player.x = HALF + 0.5; player.y = HALF + 0.5
      invuln = 1.6; regenDelay = 0; hurt = 0
      showMessage('everything goes dark. you wake where you fell in.')
      setTimeout(() => { transitioning = false }, 150)
    })
  }

  // ── input ──
  const K = Object.create(null)
  let locked = false
  window.addEventListener('keydown', e => { K[e.code] = true })
  window.addEventListener('keyup',   e => { K[e.code] = false })
  canvas.addEventListener('click', () => canvas.requestPointerLock())
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas })
  document.addEventListener('mousemove', e => { if (locked) player.angle += e.movementX * 0.002 })

  // ── wish dialog ──
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
  function closeDialog() { dialogOpen = false; if (dialogEl) dialogEl.style.display = 'none' }
  document.getElementById('wish-cancel')?.addEventListener('click', closeDialog)
  document.getElementById('wish-submit')?.addEventListener('click', async () => {
    const text = wishText?.value.trim()
    if (!text) return
    if (wishResp) wishResp.textContent = 'your request has been received. whether it is heard is another matter.'
    wishText.disabled = true
    document.getElementById('wish-submit').disabled = true
    try { if (window.backrooms?.submitWish) await window.backrooms.submitWish(text) } catch (e) { /* silent */ }
    setTimeout(() => {
      wishText.disabled = false
      document.getElementById('wish-submit').disabled = false
      closeDialog()
    }, 3000)
  })

  // ── resize ──
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
  window.addEventListener('resize', resize)
  resize()

  const SPEED = 0.05
  function tryMove(nx, ny) {
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    if (!level.cache.isWall(nx, player.y, pcx, pcy)) player.x = nx
    if (!level.cache.isWall(player.x, ny, pcx, pcy)) player.y = ny
  }

  // ── HUD (decluttered: level name only, plus optional anchor drift) ──
  const hudEl = document.getElementById('hud')
  function updateHud() {
    if (!hudEl || !level) return
    let text = level.cfg.levelName
    if (anchor) text += `   ·   drift ${driftMeters(player.x, player.y, spawnX, spawnY)}m`
    hudEl.textContent = text
  }

  // ── HP bar ──
  const hpFill = document.getElementById('hp-fill')
  function updateHp() {
    if (!hpFill) return
    const pct = Math.max(0, Math.min(100, player.hp))
    hpFill.style.width = pct + '%'
    hpFill.style.background = pct > 50 ? 'rgba(60,150,70,0.85)'
                            : pct > 25 ? 'rgba(200,165,40,0.9)'
                            :            'rgba(205,55,45,0.95)'
  }

  // ── stamina bar ──
  const stamWrap = document.getElementById('stamina-wrap')
  const stamFill = document.getElementById('stamina-fill')
  function updateStamina() {
    if (!stamWrap || !stamFill) return
    stamWrap.style.opacity = stamina < 99.5 ? '1' : '0'
    stamFill.style.width = `${Math.max(0, Math.min(100, stamina))}%`
  }

  // ── hotbar (click a slot to select; discard button drops the selected item) ──
  const hotbarEl = document.getElementById('hotbar')
  function renderHotbar() {
    if (!hotbarEl) return
    let html = ''
    for (let i = 0; i < 6; i++) {
      const item = itemSys.inventory[i]
      const sel = i === itemSys.selected ? ' sel' : ''
      const label = item ? (ITEM_NAMES[item.type] ?? item.type).split(' ')[0] + (item.on ? ' ♪' : '') : ''
      html += `<div class="slot${sel}" data-slot="${i}"><span class="num">${i + 1}</span>${label}</div>`
    }
    hotbarEl.innerHTML = html
    for (const el of hotbarEl.querySelectorAll('.slot')) {
      el.addEventListener('click', () => { itemSys.select(+el.dataset.slot); renderHotbar() })
    }
  }
  function discardSelected() {
    const res = itemSys.discardSelected()
    if (res) showMessage(`you drop the ${ITEM_NAMES[res.type] ?? res.type}.`)
    renderHotbar()
  }
  document.getElementById('btn-discard')?.addEventListener('click', discardSelected)

  // ── messages (black text, fades via opacity — see CSS) ──
  const msgEl  = document.getElementById('msg')
  let msgTimer = 0
  let msgNext  = base.messageInterval[0] + Math.random() * (base.messageInterval[1] - base.messageInterval[0])
  function showMessage(text) {
    if (!msgEl || !text) return
    msgEl.textContent = text
    msgEl.style.opacity = '1'
    clearTimeout(showMessage._t)
    showMessage._t = setTimeout(() => { msgEl.style.opacity = '0' }, 4200)
  }

  // ── polaroid ──
  const flashEl = document.getElementById('flash')
  function firePolaroid() {
    let dataUrl = null
    try { dataUrl = canvas.toDataURL('image/png') } catch { /* ignore */ }
    if (flashEl) {
      flashEl.style.transition = 'none'; flashEl.style.opacity = '0.9'
      requestAnimationFrame(() => { flashEl.style.transition = 'opacity 1.2s'; flashEl.style.opacity = '0' })
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
      stamina = 100; calmTimer = 20
      showMessage('the water is sweet. the lights steady.')
    } else if (eff.type === 'glowstick') {
      fogTimer = 45
      showMessage('green light pushes at the dark.')
    } else if (eff.type === 'bandage') {
      player.hp = Math.min(player.maxHp, player.hp + 40)
      showMessage('you patch yourself up. it holds, for now.')
    } else if (eff.type === 'polaroid') {
      firePolaroid()
    } else if (eff.type === 'radio') {
      showMessage(eff.on ? 'the radio crackles to life.' : 'the radio falls silent.')
    }
    renderHotbar()
  }

  // ── boot the first level ──
  buildLevel(0)
  showMessage(level.cfg.levelName)

  let last = 0
  function loop(ts) {
    const dt = Math.min((ts - last) / 1000, 0.05)
    last = ts
    const cfg = level.cfg

    // ── flicker (per-level tuning) ──
    const fl = cfg.flicker
    flickTimer -= dt
    if (calmTimer > 0) {
      calmTimer -= dt
      flickTgt = 0.97
    } else if (flickTimer <= 0) {
      if (Math.random() < fl.rate) {
        flickTgt   = 1 - fl.depth * Math.random()
        flickTimer = 0.04 + Math.random() * 0.12
      } else {
        flickTgt   = 0.92 + Math.random() * 0.08
        flickTimer = 0.8  + Math.random() * 3
      }
    }
    flicker += (flickTgt - flicker) * Math.min(1, dt * fl.recoverySpeed)
    setFlicker(flicker)

    // ── movement (frozen during a transition fade) ──
    let moved = false
    if (!transitioning) {
      const wantSprint = (K['ShiftLeft'] || K['ShiftRight']) && stamina > 0
      const mult = wantSprint ? 1.8 : 1
      const sp = SPEED * dt * 60 * mult
      const ca = Math.cos(player.angle), sa = Math.sin(player.angle)
      if (K['KeyW'] || K['ArrowUp'])   { tryMove(player.x + ca * sp, player.y + sa * sp); moved = true }
      if (K['KeyS'] || K['ArrowDown']) { tryMove(player.x - ca * sp * 0.6, player.y - sa * sp * 0.6); moved = true }
      if (K['KeyA'])                   { tryMove(player.x + Math.cos(player.angle - Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle - Math.PI/2) * sp * 0.7); moved = true }
      if (K['KeyD'])                   { tryMove(player.x + Math.cos(player.angle + Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle + Math.PI/2) * sp * 0.7); moved = true }
      if (!locked && K['ArrowLeft'])  player.angle -= 0.04
      if (!locked && K['ArrowRight']) player.angle += 0.04
      if (moved && wantSprint) stamina = Math.max(0, stamina - 22 * dt)
      else                     stamina = Math.min(100, stamina + 9 * dt)
    }
    player.moving = moved
    if (moved) player.bob += 0.12
    player.bobOffset = moved ? Math.sin(player.bob) * 4 : 0

    if (fogTimer > 0) fogTimer -= dt
    const fogMul = fogTimer > 0 ? 1.6 : 1

    // ── atmospheric messages ──
    msgTimer += dt
    if (msgTimer >= msgNext) {
      msgTimer = 0
      msgNext  = base.messageInterval[0] + Math.random() * (base.messageInterval[1] - base.messageInterval[0])
      showMessage(level.messages[Math.floor(Math.random() * level.messages.length)])
    }
    updateHud(); updateHp(); updateStamina()

    // ── radio audio sync ──
    const radioOn = itemSys.isRadioOn()
    if (radioOn !== radioWasOn) { radioWasOn = radioOn; setRadio(radioOn) }

    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)

    // ── presence proximity (radio finds them from farther) ──
    const presenceRange = radioOn ? 400 : 4
    let nearPresence = false
    for (let dy = -1; dy <= 1 && !nearPresence; dy++) {
      for (let dx = -1; dx <= 1 && !nearPresence; dx++) {
        const cx = pcx + dx, cy = pcy + dy
        if (!chunkHasPresence(cx, cy)) continue
        const px2 = cx * CHUNK_SIZE + CHUNK_SIZE / 2
        const py2 = cy * CHUNK_SIZE + CHUNK_SIZE / 2
        if ((player.x - px2) ** 2 + (player.y - py2) ** 2 < presenceRange) nearPresence = true
      }
    }
    const hintEl = document.getElementById('presence-hint')
    if (hintEl) hintEl.style.opacity = nearPresence ? '1' : '0'

    // ── items: pickup prompt ──
    const nearItem = itemSys.nearestItem(player.x, player.y, 1.4)
    // ── exits: descent prompt ──
    const nearExit = level.decor.nearestExit(player.x, player.y, 1.1)

    const itemHintEl = document.getElementById('item-hint')
    if (itemHintEl) {
      if (nearItem) {
        itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}`
        itemHintEl.style.opacity = '1'
      } else if (nearExit) {
        itemHintEl.textContent = `f · ${cfg.exit?.label ?? 'descend'}`
        itemHintEl.style.opacity = '1'
      } else {
        itemHintEl.style.opacity = '0'
      }
    }

    if (!transitioning && !dialogOpen) {
      // F — item first, else exit
      if (K['KeyF']) {
        K['KeyF'] = false
        if (nearItem) {
          const res = itemSys.pickUp(nearItem.key)
          if (res.ok) showMessage(`you take the ${ITEM_NAMES[res.item.type] ?? res.item.type}.`)
          else if (res.reason === 'full') showMessage('your hands are full.')
          renderHotbar()
        } else if (nearExit) {
          descend(nearExit.target, cfg.exit?.label)
        }
      }
      if (K['KeyQ']) { K['KeyQ'] = false; applyItemEffect(itemSys.useSelected()) }
      if (K['KeyX']) { K['KeyX'] = false; discardSelected() }
      for (let i = 0; i < 6; i++) {
        const code = `Digit${i + 1}`
        if (K[code]) { K[code] = false; itemSys.select(i); renderHotbar() }
      }
      if (K['KeyE'] && nearPresence) { K['KeyE'] = false; openDialog() }
    }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // ── stream world + subsystems around the player ──
    level.cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)
    level.decor.update(pcx, pcy)
    if (mpClient?.isConnected()) mpClient.sendPos(player.x, player.y, player.angle)
    level.entitySys.update(dt, player, pcx, pcy, radioOn ? 1.5 : 1)

    // ── HP: stalker contact damage, i-frames, delayed regen, death ──
    if (invuln > 0) invuln -= dt
    if (!transitioning && cfg.entities?.enabled && invuln <= 0) {
      const dmg = cfg.entities.damage ?? 16
      for (const e of level.entitySys.getEntities()) {
        if (e.type !== 'stalker') continue
        if ((e.x - player.x) ** 2 + (e.y - player.y) ** 2 < 0.6 * 0.6) {
          player.hp -= dmg; invuln = 0.7; hurt = 1; regenDelay = 6
          showMessage('it has you.')
          break
        }
      }
    }
    if (regenDelay > 0) regenDelay -= dt
    else if (player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + 3.5 * dt)
    if (hurt > 0) hurt = Math.max(0, hurt - dt * 2)
    const hurtEl = document.getElementById('hurt')
    if (hurtEl) hurtEl.style.opacity = (hurt * 0.55).toFixed(2)
    if (player.hp <= 0) { player.hp = 0; die() }

    // ── assemble sprites and render ──
    const remoteEntities = mpClient
      ? mpClient.getRemotePlayers().map(p => ({
          x: p.x, y: p.y, type: 'stalker', state: 'chase', dir: 0, dirTimer: 0,
          chunkCx: Math.floor(p.x / CHUNK_SIZE), chunkCy: Math.floor(p.y / CHUNK_SIZE),
        }))
      : []
    const propEntities = level.decor.getProps().map(p => ({ x: p.x, y: p.y, kind: 'prop', type: p.type }))
    const exitEntities = level.decor.getExits().map(e => ({ x: e.x, y: e.y, kind: 'exit' }))
    const itemEntities = itemSys.getWorldItems().map(it => ({ x: it.x, y: it.y, kind: 'item', itemType: it.type }))
    const allEntities = [
      ...level.entitySys.getEntities(), ...remoteEntities,
      ...propEntities, ...exitEntities, ...itemEntities,
    ]

    level.gfx.render(player, (wx, wy) => level.cache.isWall(wx, wy, pcx, pcy), flicker, allEntities, fogMul)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}
