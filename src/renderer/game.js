import { loadConfig, CHUNK_SIZE, createChunkCache } from './world.js'
import { levelConfig } from './levels.js'
import { createEntitySystem } from './entities.js'
import { createItemSystem } from './items.js'
import { createDecorSystem } from './decor.js'
import { createRenderer } from './renderer.js'
import { initAudio, setFlicker, setRadio, setMusic, setMusicEnabled, setMusicVolume, setAmbience, blip } from './audio.js'
import { getPref, setPref, onPrefChange } from './prefs.js'
import { writeSave } from './save.js'
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

// Things a lost soul might tell you — lore, warnings, and the odd real hint.
const NPC_LINES = [
  'i have been here longer than you have been alive.',
  "don't trust the almond water on the deeper floors.",
  'if the lights go out, stop moving. it hunts movement.',
  'the way down is near the torn wallpaper. never a way up.',
  'you hear the smiler before you see it. that grin.',
  'the humming is a language. i almost understand it now.',
  'have you seen my daughter? she was right behind me.',
  'the walls are thin where the carpet is wet. clip through.',
  'stay away from the ones that walk on all fours.',
  'we are not lost. we are exactly where it wants us.',
  'bring a light to the pipes. the dark there is not empty.',
  "if you make it out, don't tell them about me.",
]

// A directional arrow (clockwise from straight-ahead) for the descent compass.
const EXIT_DIRS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']
function exitArrow(rel) {
  let a = rel % (Math.PI * 2)
  if (a < 0) a += Math.PI * 2
  return EXIT_DIRS[Math.round(a / (Math.PI / 4)) % 8]
}

export async function initGame(canvas, { worldSeed = null, mpClient = null, anchor = null, resume = null } = {}) {
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
  let netTimer   = 0    // throttles position updates to the server (~20Hz)
  let flashlight = true // the player's own light (toggle with L)

  // Flicker state (persists; retuned per level via level.cfg.flicker)
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0

  initAudio(base)

  // shared, live-mutable render options (toggled from the settings panel)
  const renderOpts = { grain: getPref('grain'), particles: getPref('particles'), crosshair: getPref('crosshair') }

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
    const gfx       = createRenderer(canvas, cfg, renderOpts)
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
    setMusic(cfg.music)          // morph the generative bed into this level's mood

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
      persist()                       // save on every descent
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
  document.addEventListener('mousemove', e => { if (locked) player.angle += e.movementX * 0.002 * (getPref('mouseSensitivity') / 100) })

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

  // ── multiplayer chat ──
  const chatLogEl    = document.getElementById('chat-log')
  const chatInputEl  = document.getElementById('chat-input')
  const chatTypingEl = document.getElementById('chat-typing')
  let chatOpen = false
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const nameColor = (n) => { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return `hsl(${h % 360} 72% 68%)` }
  const chatLines = []
  function renderChat() {
    if (!chatLogEl) return
    chatLogEl.innerHTML = chatLines.map(l => {
      if (l.sys) return `<div class="chat-sys">— ${escapeHtml(l.from)} ${escapeHtml(l.text)}</div>`
      if (l.text.startsWith('/me ')) return `<div class="chat-me" style="color:${nameColor(l.from)}">✦ ${escapeHtml(l.from)} ${escapeHtml(l.text.slice(4))}</div>`
      return `<div class="chat-line"><b style="color:${nameColor(l.from)}">${escapeHtml(l.from)}</b> ${escapeHtml(l.text)}</div>`
    }).join('')
    chatLogEl.style.opacity = '1'
    clearTimeout(renderChat._t)
    renderChat._t = setTimeout(() => { if (!chatOpen) chatLogEl.style.opacity = '0.3' }, 7000)
  }
  function addChatLine(from, text, isSystem) {
    chatLines.push({ from, text, sys: isSystem })
    if (chatLines.length > 8) chatLines.shift()
    renderChat()
    if (!isSystem && mpClient && from !== mpClient.getName()) blip()   // ping on others' messages
  }
  // incoming "is typing…"
  let typingHideT = null
  function showTyping(name, on) {
    if (!chatTypingEl) return
    clearTimeout(typingHideT)
    if (on) { chatTypingEl.textContent = `${name} is typing…`; chatTypingEl.style.opacity = '1'; typingHideT = setTimeout(() => { chatTypingEl.style.opacity = '0' }, 4000) }
    else { chatTypingEl.style.opacity = '0' }
  }
  // outgoing typing signal (debounced)
  let typingSent = false, typingStopT = null
  function noteTyping() {
    if (!mpClient) return
    if (!typingSent) { typingSent = true; mpClient.sendTyping(true) }
    clearTimeout(typingStopT)
    typingStopT = setTimeout(() => { typingSent = false; mpClient.sendTyping(false) }, 1800)
  }
  function openChat() {
    if (!mpClient || !chatInputEl || chatOpen) return
    chatOpen = true
    for (const k in K) K[k] = false            // drop any held movement keys
    document.exitPointerLock()
    chatInputEl.style.display = 'block'; chatInputEl.value = ''; chatInputEl.focus()
    if (chatLogEl) chatLogEl.style.opacity = '1'
  }
  function closeChat() {
    chatOpen = false
    if (chatInputEl) chatInputEl.style.display = 'none'
    if (typingSent) { typingSent = false; clearTimeout(typingStopT); mpClient?.sendTyping(false) }
  }
  chatInputEl?.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { const t = chatInputEl.value.trim(); if (t) mpClient?.sendChat(t); closeChat() }
    else if (e.code === 'Escape') closeChat()
    else noteTyping()
  })
  if (mpClient) {
    mpClient.onChat(addChatLine)
    mpClient.onTyping(showTyping)
    addChatLine('', 'connected — Enter to chat · /me to emote', true)
  }

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

  // ── snapshot + persistence (solo progress & inventory — the "save game") ──
  function snapshot() {
    return {
      level: level?.index ?? 0,
      x: player.x, y: player.y, angle: player.angle,
      hp: player.hp, maxHp: player.maxHp,
      inventory: itemSys.inventory.map(i => ({ type: i.type, ...(i.on ? { on: true } : {}) })),
      selected: itemSys.selected,
      worldSeed, anchor,
    }
  }
  let saveTimer = 0
  const persist = () => { if (!mpClient) writeSave(snapshot()) }   // solo runs are the ones you resume
  window.addEventListener('beforeunload', persist)

  // ── boot: resume a saved run, or start fresh at level 0 ──
  if (resume) {
    buildLevel(resume.level ?? 0)
    player.x = resume.x ?? player.x
    player.y = resume.y ?? player.y
    player.angle = resume.angle ?? 0
    player.maxHp = resume.maxHp ?? 100
    player.hp = resume.hp ?? player.maxHp
    if (Array.isArray(resume.inventory)) {
      itemSys.inventory.length = 0
      for (const it of resume.inventory) itemSys.inventory.push({ type: it.type, ...(it.on ? { on: true } : {}) })
      itemSys.select(Math.max(0, Math.min(5, resume.selected ?? 0)))
      renderHotbar()
    }
  } else {
    buildLevel(0)
  }
  showMessage(level.cfg.levelName)

  // apply saved audio/visual prefs, then keep them live as the panel changes them
  setMusicEnabled(getPref('music'))
  setMusicVolume(getPref('musicVolume'))
  setAmbience(getPref('ambience'))
  onPrefChange((k, v) => {
    if (k === 'grain')          renderOpts.grain = v
    else if (k === 'particles') renderOpts.particles = v
    else if (k === 'crosshair') renderOpts.crosshair = v
    else if (k === 'music')     setMusicEnabled(v)
    else if (k === 'musicVolume') setMusicVolume(v)
    else if (k === 'ambience')  setAmbience(v)
    // mouseSensitivity, headBob, creatures and damage are read live each frame
  })

  let last = 0
  let frameCount = 0
  let loopErrs = 0
  function loop(ts) {
   try {
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

    // ── movement (frozen during a transition fade or while typing in chat) ──
    let moved = false
    if (!transitioning && !chatOpen) {
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
    player.bobOffset = (moved && getPref('headBob')) ? Math.sin(player.bob) * 4 : 0

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
    saveTimer += dt
    if (saveTimer > 8) { saveTimer = 0; persist() }

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
    // ── exits: descent prompt (wider grab range) ──
    const nearExit = level.decor.nearestExit(player.x, player.y, 1.6)
    const nearNpc  = level.decor.nearestNpc(player.x, player.y, 1.8)

    const itemHintEl = document.getElementById('item-hint')
    if (itemHintEl) {
      if (nearItem) {
        itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}`
        itemHintEl.style.opacity = '1'
      } else if (nearExit) {
        itemHintEl.textContent = `f · ${cfg.exit?.label ?? 'descend'}`
        itemHintEl.style.opacity = '1'
      } else if (nearNpc) {
        itemHintEl.textContent = 'e · speak to the lost soul'
        itemHintEl.style.opacity = '1'
      } else {
        itemHintEl.style.opacity = '0'
      }
    }

    // ── descent compass — points at the nearest loaded exit so it's findable ──
    const compassEl = document.getElementById('exit-compass')
    if (compassEl) {
      const anyExit = level.decor.nearestExitAny(player.x, player.y)
      if (anyExit && !nearExit) {
        const rel = Math.atan2(anyExit.y - player.y, anyExit.x - player.x) - player.angle
        compassEl.textContent = `${exitArrow(rel)}  ${cfg.exit?.label ?? 'descent'}  ·  ${Math.round(anyExit.dist)}m`
        compassEl.style.opacity = '1'
      } else {
        compassEl.style.opacity = '0'
      }
    }

    // Enter opens chat when connected to others
    if (mpClient && !chatOpen && !dialogOpen && (K['Enter'] || K['NumpadEnter'])) {
      K['Enter'] = false; K['NumpadEnter'] = false; openChat()
    }

    if (!transitioning && !dialogOpen && !chatOpen) {
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
      if (K['KeyM']) { K['KeyM'] = false; const on = !getPref('music'); setPref('music', on); showMessage(on ? 'the music seeps back in.' : 'the music stops.') }
      if (K['KeyL']) { K['KeyL'] = false; flashlight = !flashlight; showMessage(flashlight ? 'flashlight on.' : 'flashlight off — the dark leans in.') }
      for (let i = 0; i < 6; i++) {
        const code = `Digit${i + 1}`
        if (K[code]) { K[code] = false; itemSys.select(i); renderHotbar() }
      }
      if (K['KeyE']) {
        K['KeyE'] = false
        if (nearPresence) openDialog()
        else if (nearNpc) showMessage(NPC_LINES[Math.floor(Math.random() * NPC_LINES.length)])
      }
    }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // ── stream world + subsystems around the player ──
    level.cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)
    level.decor.update(pcx, pcy)
    netTimer += dt
    if (mpClient?.isConnected() && netTimer >= 0.05) { netTimer = 0; mpClient.sendPos(player.x, player.y, player.angle) }
    // creatures can be switched off entirely (pure liminal exploration)
    const creaturesOn = getPref('creatures')
    if (creaturesOn) level.entitySys.update(dt, player, pcx, pcy, radioOn ? 1.5 : 1)

    // ── HP: stalker contact damage, i-frames, delayed regen, death ──
    if (invuln > 0) invuln -= dt
    if (!transitioning && creaturesOn && getPref('damage') && cfg.entities?.enabled && invuln <= 0) {
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
      ? mpClient.getRemotePlayers().map(p => ({ x: p.x, y: p.y, kind: 'player', name: p.name || 'wanderer', angle: p.angle, chatText: p.chatText }))
      : []
    const propEntities = level.decor.getProps().map(p => ({ x: p.x, y: p.y, kind: 'prop', type: p.type }))
    const exitEntities = level.decor.getExits().map(e => ({ x: e.x, y: e.y, kind: 'exit' }))
    const npcEntities  = level.decor.getNpcs().map(n => ({ x: n.x, y: n.y, kind: 'npc', name: 'a lost soul' }))
    const itemEntities = itemSys.getWorldItems().map(it => ({ x: it.x, y: it.y, kind: 'item', itemType: it.type }))
    const enemyEntities = creaturesOn ? level.entitySys.getEntities() : []
    const allEntities = [
      ...enemyEntities, ...remoteEntities, ...npcEntities,
      ...propEntities, ...exitEntities, ...itemEntities,
    ]

    level.gfx.render(player, (wx, wy) => level.cache.isWall(wx, wy, pcx, pcy), flicker, allEntities, fogMul,
      { flashlight, glow: fogTimer > 0 ? [80, 235, 110] : null })
    frameCount++
   } catch (e) {
    // A per-frame error must never permanently freeze the game: log it (first
    // few only, to avoid flooding) and fall through to reschedule below.
    loopErrs++
    if (loopErrs <= 5) {
      try { window.backrooms?.logError?.(`loop#${loopErrs} @frame${frameCount} lvl${level?.index}: ${(e && e.stack) || e}`) } catch (_) {}
    }
   }
   requestAnimationFrame(loop)   // ALWAYS reschedule — resilience over a stray throw
  }
  requestAnimationFrame(loop)

  // Stall watchdog — if requestAnimationFrame stops advancing (a GPU/compositor
  // hang that never trips main's 'unresponsive'), record it so the freeze finally
  // leaves a trace in the log instead of vanishing silently.
  let watchPrev = -1
  setInterval(() => {
    // Only a real stall counts — rAF legitimately pauses when the window is
    // hidden/minimized, so don't cry wolf then.
    if (frameCount === watchPrev && document.visibilityState === 'visible') {
      try { window.backrooms?.logError?.(`render loop STALLED — no new frames for ~4s at frame ${frameCount} (level ${level?.index})`) } catch (_) {}
    }
    watchPrev = frameCount
  }, 4000)
}
