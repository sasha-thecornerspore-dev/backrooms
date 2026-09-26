import { loadConfig, CHUNK_SIZE, createChunkCache } from './world.js'
import { createFixedMap } from './fixedmap.js'
import { levelConfig, TRACKS } from './levels.js'
import { createEntitySystem } from './entities.js'
import { createItemSystem } from './items.js'
import { createDecorSystem } from './decor.js'
import { createRenderer } from './renderer.js'
import { initAudio, setFlicker, setRadio, setMusic, setMusicEnabled, setMusicVolume, setAmbience, setAmbienceVolume, blip, heartbeat, whisper, wardPulse, doorSlam, footfall, humDuck } from './audio.js'
import { getPref, setPref, onPrefChange } from './prefs.js'
import { readDeviceEnv, createQualityDirector, createFramePacer, createFlickerState, stepFlicker, flashFor, flashWait, noteFlash, DEFAULT_MAX_GLOBAL_DIP, qualityFor } from './gfx-quality.js'
import { statsEnabled, createStatsOverlay } from './gfx-stats.js'
import { writeSave } from './save.js'
import { formatAnchor, driftMeters } from './anchor.js'
import { initTouchControls, isTouchDevice } from './touch.js'
import { SCRAPS } from './scraps.js'
import { createEventScheduler } from './events.js'

// Presence: 1 in 12 chunks has a spirit at its midpoint
function chunkHasPresence(cx, cy) {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xFF) % 12 === 0
}

const ITEM_NAMES = {
  'almond-water':   'almond water',
  'glowstick':      'glowstick',
  'bandage':        'bandage',
  'polaroid':       'polaroid camera',
  'radio':          'radio',
  'plumb':          'survey plumb',
  'ballast':        'ballast',
  'extension-slip': 'extension slip',
}

// The numbers station in the deep stacks reads the ledger aloud — the count that
// decodes (subtract the drift 3, then A=1..Z=26) to the counter-claim you type at
// the presence. Delivered as readable groups so it can be transcribed, not blips.
const RADIO_GROUPS = ['12 26 04 22 11 08', '21 08 19 24 23 12', '23 12 17 23 11 08', '09 12 15 08']
// the counter-claim, typed at the presence: normalise and look for "i was here".
const isClaim = (t) => /iwashere/.test(String(t).toLowerCase().replace(/[^a-z]/g, ''))

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

// ── per-frame plumbing that must not allocate (pure, exported for test/gfx-hc-game.test.js) ──

// The sprite list handed to render() every frame, assembled WITHOUT fresh objects: each category keeps a pool of records that are
// overwritten in place (index i of a category always goes through the same fill function, so every record keeps one shape and its fields in
// the literal's order), and the output array itself is reused. What the renderer receives is exactly what the old per-frame .map() built —
// same fields, same values, same order. Safe because no renderer stage keeps an entity across frames or keys anything on its identity
// (the sprite passes key motion on id/key/name, the GL atlas on its own mips).
//   const A = createEntityAssembler()
//   A.begin(); A.pass(list) (objects handed through as-is); A.add('prop', list, fill, ctx) ...; const all = A.end()
export function createEntityAssembler() {
  const out = []
  const pools = Object.create(null)
  let n = 0
  return {
    begin() { n = 0 },
    // objects that are already what the renderer wants (the entity system's enemies): handed through untouched
    pass(list) { for (let i = 0; i < list.length; i++) out[n++] = list[i] },
    // one pooled record per element of `list`, written by fill(record, element, ctx)
    add(cat, list, fill, ctx) {
      const pool = pools[cat] || (pools[cat] = [])
      for (let i = 0; i < list.length; i++) {
        let r = pool[i]
        if (r === undefined) r = pool[i] = {}
        fill(r, list[i], ctx)
        out[n++] = r
      }
    },
    end() { if (out.length !== n) out.length = n; return out },
    poolSize(cat) { return pools[cat] ? pools[cat].length : 0 },
  }
}
// the record fills: field for field (and in the order of) the object literals game.js used to build every frame
export const ENTITY_FILLS = Object.freeze({
  player:  (r, p) => { r.x = p.x; r.y = p.y; r.kind = 'player'; r.name = p.name || 'wanderer'; r.angle = p.angle; r.chatText = p.chatText; r.hp = p.hp },
  npc:     (r, n) => { r.x = n.x; r.y = n.y; r.kind = 'npc'; r.name = 'a lost soul'; r.key = n.key },
  prop:    (r, p) => { r.x = p.x; r.y = p.y; r.kind = 'prop'; r.type = p.type; r.rot = p.rot; r.key = p.key },
  exit:    (r, e) => { r.x = e.x; r.y = e.y; r.kind = 'exit'; r.target = e.target; r.key = e.key },
  item:    (r, it) => { r.x = it.x; r.y = it.y; r.kind = 'item'; r.itemType = it.type; r.key = it.key },
  note:    (r, s, readSet) => { r.x = s.x; r.y = s.y; r.kind = 'note'; r.read = readSet.has(s.frag); r.frag = s.frag; r.key = s.key },
  machine: (r, m, vendedSet) => { r.x = m.x; r.y = m.y; r.kind = 'machine'; r.vended = vendedSet.has(m.key); r.key = m.key },
  sight:   (r, s) => { r.x = s.x; r.y = s.y; r.kind = 'sight'; r.sightType = s.type; r.key = s.key },
  apparition: (r, a) => { r.x = a.x; r.y = a.y; r.variant = a.variant; r.vx = a.vx; r.vy = a.vy },
})

// Window resizes come in storms (a drag fires dozens a second, each used to reallocate the canvas and the renderer's buffers). They only
// raise a flag; the game loop takes it at most once per animation frame, before it draws.
export function createResizeGate() {
  let pending = false
  return { request() { pending = true }, take() { const p = pending; pending = false; return p }, get pending() { return pending } }
}
// Call onChange once when window.devicePixelRatio changes (the window moved to another display, the browser zoom changed). A
// `(resolution: Xdppx)` media query fires when the ratio leaves X; it is re-armed for the new ratio each time. -> stop()
export function watchDpr(win, onChange) {
  let mql = null, stopped = false
  const arm = () => {
    if (stopped) return
    try {
      mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', fire, { once: true })
    } catch { mql = null }       // no matchMedia / an old engine: the loop's periodic check still catches it
  }
  function fire() { if (stopped) return; try { onChange() } finally { arm() } }
  arm()
  return () => { stopped = true; try { if (mql) mql.removeEventListener('change', fire) } catch { /* ignore */ } }
}

// After a level change the screen stays black until the new level has drawn this many frames (its first frames carry the one-time costs:
// lazily built sprites, the GPU's first-frame validation on the 4th render), or until SETTLE_MAX_MS, whichever comes first — so those costs
// land under the fade, not as a visible stutter after it.
export const SETTLE_FRAMES = 5
export const SETTLE_MAX_MS = 1500

// The level-change / respawn fade. run(cb, onShown): the veil goes black (FADE_OUT_MS), cb() swaps the level or respawns under it, and the veil
// lifts only once the NEW picture has drawn settleFrames frames (or settleMaxMs passed); onShown() runs graceMs AFTER the veil starts to lift.
// game.js ends its transition in onShown, so movement, events and contact damage stay frozen for as long as the screen is black — never
// released on a fixed timer while the veil still holds. Fades are SEQUENCED: each run() is a new generation, and the pending reveal / onShown
// of an older run does nothing once a newer run has started (an older fade can never lift the veil in the middle of a newer — a death — fade,
// nor end the newer transition). cb itself always runs: it is the state change the caller asked for.
//   deps: el (the #fade element, or null: no veil — cb, then onShown after graceMs), frames() (frames drawn so far), now(), setTimeout, raf
export const FADE_OUT_MS = 580, FADE_GRACE_MS = 150
export function createFader({
  el, frames, now = () => performance.now(), setTimeout: later = (f, ms) => setTimeout(f, ms), raf = (f) => requestAnimationFrame(f),
  fadeMs = FADE_OUT_MS, graceMs = FADE_GRACE_MS, settleFrames = SETTLE_FRAMES, settleMaxMs = SETTLE_MAX_MS,
} = {}) {
  let gen = 0
  return {
    get gen() { return gen },
    run(cb, onShown) {
      const g = ++gen
      const shown = () => { if (onShown) later(() => { if (g === gen) onShown() }, graceMs) }
      if (!el) { cb(); shown(); return }
      el.style.transition = 'opacity 0.55s'
      el.style.opacity = '1'
      later(() => {
        cb()
        if (g !== gen) return                        // a newer fade started meanwhile: it owns the veil and the transition
        const f0 = frames(), s0 = now()
        const reveal = () => {
          if (g !== gen) return
          if (frames() - f0 >= settleFrames || now() - s0 >= settleMaxMs) { el.style.opacity = '0'; shown() }
          else raf(reveal)
        }
        raf(reveal)
      }, fadeMs)
    },
  }
}

// The head of every animation frame: the fpsCap pacer FIRST, then the pending layout. A layout assigns #c's width/height, which clears it; a
// frame the pacer skips draws nothing, so a layout taken there would be PRESENTED as a cleared, transparent canvas — with a window drag or a
// pinch firing resizes every frame and fpsCap 30 (or 60 on a 120/144 Hz display) that is a scene / blank strobe. A pending layout therefore
// waits (the gate keeps it) for the next callback that goes on to draw. -> true when this frame draws.
export function frameDue(ts, pacer, fpsCap, gate, relayout) {
  if (!pacer.due(ts, fpsCap)) return false
  if (gate.take()) relayout()
  return true
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
  const itemSys = createItemSystem(base, (wx, wy, pcx, pcy) => level.cache.isWall(wx, wy, pcx, pcy), worldSeed)

  // persistent effect / combat timers
  let stamina    = 100
  let calmTimer  = 0    // almond water — lights hold steady
  let fogTimer   = 0    // glowstick — fog pushed back
  let radioWasOn = false
  let invuln     = 0    // i-frames after a hit
  let hurt       = 0    // red-flash intensity
  let regenDelay = 0    // seconds before hp regen resumes
  let wardCd     = 0    // cooldown between wards (the fight-back)
  let netTimer   = 0    // throttles position updates to the server (~20Hz)
  let flashlight = true // the player's own light (toggle with L)
  let sanity     = 100  // the dark and the things eat at it; light + friends restore it
  let sanWhisperT = 0
  let heartT     = 0
  let shake      = 0    // screen-shake magnitude, decays each frame

  // ── the numbers station + the counter-claim (the reality-tunneling arc) ──
  let stationIdx  = 0     // which group of the ledger-count the radio reads next
  let photoIdx    = 0     // the polaroid develops one glyph of the claim per clean shot
  let claimFiled  = false // the wish was typed as a claim ("i was here")
  let beaconFired = false // the beacon was fired carrying the EXTENSION-30150A claim
  let seamHeld    = false // the counter-claim resolved — fire the finale only once

  // ── Living Atmosphere — occasional ambient dread events ──
  const eventSched = createEventScheduler()
  const ephemera   = []   // transient event-spawned apparitions (render-only, no collision)

  // vending machines dispense once; keys of spent machines (mirrors items.js
  // `taken` — survives chunk eviction, cleared per level so a floor re-stocks).
  const vendedSet = new Set()

  // Flicker state (persists; retuned per level via level.cfg.flicker)
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0
  const fk = createFlickerState()   // the rate limiter's bookkeeping (gfx-quality.js stepFlicker); flicker/flickTgt/flickTimer stay ours

  initAudio(base)

  // shared, live-mutable render options (toggled from the settings panel). maxGlobalDip bounds how far the WHOLE frame
  // may dim in a flicker (0.5; reduceFlicker tightens it to 0.25) whatever quality tier is chosen.
  const renderOpts = {
    grain: getPref('grain'), particles: getPref('particles'), crosshair: getPref('crosshair'),
    reduceFlicker: getPref('reduceFlicker'), maxGlobalDip: DEFAULT_MAX_GLOBAL_DIP,
    renderer: getPref('renderer'),     // 'auto' | 'gpu' | 'cpu' — read by createRenderer() (renderer.js); 'auto' is still the CPU path until the GPU is verified
  }
  // Test / harness hook: a page that sets globalThis.__backroomsRenderOpts BEFORE the game boots (tools/gfx/page.cjs --ropts) can add renderOpts such as
  // { allowSoftwareGl: true } (WebGL on SwiftShader, never used in production) or { __failGl: 'frame' }. It is read ONLY when the harness has also marked
  // the page as a test run (globalThis.__backroomsTestRun === true, set by page.cjs' preload) — nothing in the shipped page or the URL sets either,
  // and gfx-gl.js / renderer.js re-check the marker before honouring allowSoftwareGl, __failGl and gpuValidate.
  try { const dbg = globalThis.__backroomsRenderOpts; if (dbg && typeof dbg === 'object' && globalThis.__backroomsTestRun === true) Object.assign(renderOpts, dbg) } catch { /* ignore */ }
  // The quality director turns the graphicsQuality / hiDpi / fpsCap prefs plus the frame times it is fed into
  // renderOpts.qualityTier / renderScale / uiScale and the canvas size (gfx-quality.js). resize() below lays it out.
  const qd = createQualityDirector({
    env: readDeviceEnv(navigator, window),
    graphicsQuality: getPref('graphicsQuality'), hiDpi: getPref('hiDpi'), fpsCap: getPref('fpsCap'),
  })
  let fpsCap = getPref('fpsCap')

  // ── per-level state, rebuilt on every transition ──
  let level = null
  let transitioning = false
  // what the last level start cost (buildLevel, the renderer inside it, the first frame): the ?gfxstats=1 panel shows it
  let levelStart = null
  const fadeEl = document.getElementById('fade')

  // ── track selection (N) ──
  // -1 means "this floor's own mood"; 0..n-1 index TRACKS. The choice persists
  // across descents (see buildLevel) so a track you like isn't torn away the
  // moment you fall through a floor. Declared HERE, above buildLevel, because
  // buildLevel reads it and runs before this point in initGame — a `let` further
  // down would be in the temporal dead zone and throw on boot.
  let trackIdx = getPref('track')
  if (!Number.isInteger(trackIdx) || trackIdx < -1 || trackIdx >= TRACKS.length) trackIdx = -1

  function cycleTrack() {
    trackIdx = trackIdx + 1 >= TRACKS.length ? -1 : trackIdx + 1
    setPref('track', trackIdx)
    if (trackIdx < 0) {
      setMusic(level.cfg.music)
      showMessage('the building resumes its own song.')
    } else {
      const t = TRACKS[trackIdx]
      setMusic(t.mood)
      showMessage(t.hint)
    }
  }

  // one renderer for a level (buildLevel; and a live change of the renderer pref). Logs one hidden diagnostics line: kind / why / GPU info.
  function makeGfx(cfg, cache) {
    const g = createRenderer(canvas, cfg, renderOpts, cfg.map ? { materialAt: (wx, wy) => cache.materialAt(wx, wy) } : {})
    try { console.info(g.diagnostics()) } catch { /* a console-less host */ }
    return g
  }

  function buildLevel(index) {
    const tb    = performance.now()
    const cfg   = levelConfig(base, index)
    // HUD theme hook: index.html restyles body[data-level] ('0'..'3' | '∅') — light ink on dark plates below the lobby
    if (typeof document !== 'undefined' && document.body) document.body.dataset.level = String(cfg.levelIndex)
    // Level ∅ is a hand-authored fixed grid; the rest are procedural chunk worlds.
    // Both expose the same isWall(wx,wy,pcx,pcy); the fixed map adds materialAt.
    const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, worldSeed)
    cache.preload(0, 0)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const entitySys = createEntitySystem(cfg, isWall)
    const decor     = createDecorSystem(cfg, isWall, worldSeed)
    // The previous level's renderer is disposed BEFORE the next one is created: a GPU backend owns a WebGL context on a sibling canvas, and
    // browsers cap live contexts (~16), so a level change must not leave one behind.
    if (level && level.gfx) { try { level.gfx.dispose() } catch { /* a half-torn-down renderer must never block a level change */ } level.gfx = null }
    const tg        = performance.now()
    const gfx       = makeGfx(cfg, cache)
    const gfxMs     = performance.now() - tg
    itemSys.enterLevel(cfg)
    vendedSet.clear()               // a re-entered floor re-stocks its machines

    // fixed maps spawn at their authored point; procedural at the origin room (carved open)
    if (cfg.spawn) { player.x = cfg.spawn.x; player.y = cfg.spawn.y }
    else { player.x = HALF + 0.5; player.y = HALF + 0.5 }
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
    // Morph the bed into this level's mood — unless the player has chosen an
    // alternate track with N, in which case their choice follows them down.
    setMusic(trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood)

    updateHud()
    renderHotbar()
    levelStart = { level: cfg.levelIndex, t0: tb, buildMs: performance.now() - tb, gfxMs, firstMs: NaN, readyMs: NaN, frames: 0 }
    return level
  }

  // lift the veil only once the (new) level has drawn its first frames, so their one-time costs stay under it (SETTLE_FRAMES); the transition
  // (frozen movement, events, contact damage) ends a moment after the veil lifts, not while it is still black (createFader)
  const fader = createFader({ el: fadeEl, frames: () => frameCount })
  function fadeThen(cb) { fader.run(cb, () => { transitioning = false }) }

  function descend(target, label) {
    if (transitioning) return
    transitioning = true
    document.exitPointerLock()
    fadeThen(() => {
      buildLevel(target)
      persist()                       // save on every descent
      showMessage(level.cfg.levelName)
      if (level.cfg.exit?.hint) setTimeout(() => showMessage(level.cfg.exit.hint), 3800)
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
    })
  }

  // ── input ──
  const K = Object.create(null)
  let locked = false
  // settings panel has text fields (e.g. the beacon target URL) — without this guard,
  // typing a webhook into them feeds every character into the game's key map and plays the game
  window.addEventListener('keydown', e => {
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (e.code === 'Space') e.preventDefault()
    K[e.code] = true
  })
  window.addEventListener('keyup',   e => { K[e.code] = false })
  // Pointer-lock mouse-look is desktop only; on touch the on-screen controls
  // drive movement + look instead (initTouchControls, below).
  if (!isTouchDevice()) canvas.addEventListener('click', () => canvas.requestPointerLock())
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas })
  document.addEventListener('mousemove', e => { if (locked) player.angle += e.movementX * 0.002 * (getPref('mouseSensitivity') / 100) })

  // ── touch controls (phones / ChromeOS tablets) — feeds K + player.angle;
  //    a no-op on desktop, so keyboard play is unchanged ──
  initTouchControls({ canvas, K, player, getPref })

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
    const claim = isClaim(text)
    if (wishResp) wishResp.textContent = claim
      ? 'you did not ask. you asserted. the file has no column to deny a claim made. received.'
      : 'your request has been received. whether it is heard is another matter.'
    wishText.disabled = true
    document.getElementById('wish-submit').disabled = true
    try { if (window.backrooms?.submitWish) await window.backrooms.submitWish(text) } catch (e) { /* silent */ }
    if (claim) { claimFiled = true; tryFinale() }
    setTimeout(() => {
      wishText.disabled = false
      document.getElementById('wish-submit').disabled = false
      closeDialog()
    }, 3000)
  })

  // ── found scraps: notes left by earlier wanderers, read on a paper card ──
  const readSet = new Set()          // distinct frag indices the player has read
  let noteOpen = false
  const noteCardEl = document.getElementById('note-card')
  const noteTextEl = document.getElementById('note-text')
  const noteFootEl = document.getElementById('note-foot')
  function openNoteCard(scrap) {
    if (noteOpen || !scrap || !noteCardEl) return   // no card element → never freeze invisibly
    noteOpen = true
    document.exitPointerLock()
    if (!readSet.has(scrap.frag)) { readSet.add(scrap.frag); sanity = Math.min(100, sanity + 6) }   // not alone, for a moment
    noteTextEl.textContent = SCRAPS[scrap.frag] ?? ''
    noteFootEl.textContent = `${readSet.size} of ${SCRAPS.length} pages found`
    noteCardEl.style.display = 'flex'
  }
  function closeNoteCard() { noteOpen = false; if (noteCardEl) noteCardEl.style.display = 'none' }
  noteCardEl?.addEventListener('pointerdown', closeNoteCard)   // tap / click the card to put it back

  // ── resize ──
  // The backing store is the css size (today's behaviour) unless the player opted into hi-DPI, in which case the
  // director may make it up to 1.5x larger within a pixel budget; the INTERNAL render size is unaffected (renderScale
  // is scaled down to match), so a HiDPI Chromebook or phone does not silently fill more pixels.
  let lastDpr = window.devicePixelRatio
  function resize() {
    lastDpr = window.devicePixelRatio
    const p = qd.layout(window.innerWidth, window.innerHeight, lastDpr)
    if (canvas.width !== p.width || canvas.height !== p.height) { canvas.width = p.width; canvas.height = p.height }
    canvas.style.width  = p.ratio === 1 ? '' : `${p.cssW}px`
    canvas.style.height = p.ratio === 1 ? '' : `${p.cssH}px`
    qd.apply(renderOpts)
  }
  // every source of a new size only raises the flag; the loop lays out at most once per animation frame (createResizeGate)
  const resizeGate = createResizeGate()
  const queueResize = () => resizeGate.request()
  window.addEventListener('resize', queueResize)
  window.addEventListener('orientationchange', queueResize)
  watchDpr(window, queueResize)
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

  // ── sanity bar + the low-sanity screen wash ──
  const sanFill  = document.getElementById('san-fill')
  const insaneEl = document.getElementById('insanity')
  function updateSanity() {
    if (!sanFill) return
    const pct = Math.max(0, Math.min(100, sanity))
    sanFill.style.width = pct + '%'
    sanFill.style.background = pct > 50 ? 'rgba(120,112,185,0.82)'
                             : pct > 25 ? 'rgba(150,92,182,0.86)'
                             :            'rgba(184,60,140,0.92)'
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
      const full = item ? (ITEM_NAMES[item.type] ?? item.type) : ''
      const words = full.split(' ')
      // provisions read by their first word (almond, radio); a tool reads by what it is (a survey plumb is a plumb)
      const label = item ? (item.tool ? words[words.length - 1] : words[0]) + (item.on ? ' ♪' : '') : ''
      html += `<div class="slot${sel}" data-slot="${i}" title="${full}"><span class="num">${i + 1}</span>${label}</div>`
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
    if (!chatInputEl || chatOpen) return          // solo too — the input doubles as the field console
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
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      const t = chatInputEl.value.trim()
      if (t.startsWith('/') && !t.startsWith('/me ')) handleCommand(t)   // the field console
      else if (t && mpClient) mpClient.sendChat(t)
      else if (t) showMessage('no one is here to hear it.')
      closeChat()
    }
    else if (e.code === 'Escape') closeChat()
    else noteTyping()
  })

  // ── the field console: the chat input doubles as a command line, solo or
  //    online. /recover reports the open case (and at the sealed door on
  //    Level ∅ surfaces its key); /file <answer> reads the next instrument
  //    against the case manifest — the SAME salted hash and the SAME
  //    same-origin keyring the web board at /recover/ uses, so a task done in
  //    the maze shows as read on the board, and vice versa. ──
  // the open case is remembered per browser (cs.case.open); /recover <case> switches it.
  const RECOVER_DEFAULT = 'case-d8'
  const rOpenCase = () => { try { return localStorage.getItem('cs.case.open') || RECOVER_DEFAULT } catch (e) { return RECOVER_DEFAULT } }
  const rSetOpenCase = (id) => { try { localStorage.setItem('cs.case.open', id) } catch (e) {} }
  const RECOVER_SALT = 'cornerspore:'
  const rNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '')
  async function rHash(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RECOVER_SALT + rNorm(s)))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const rKey = (c, s) => 'cs.case.' + c + '.' + s
  const rSolved = (c, s) => { try { return localStorage.getItem(rKey(c, s)) === '1' } catch (e) { return false } }
  let recoverManifest = null, recoverIndex = null
  async function loadIndex() {
    if (recoverIndex) return recoverIndex
    const r = await fetch('../recover/cases/index.json', { cache: 'no-store' })
    if (!r.ok) throw new Error('no index')
    recoverIndex = (await r.json()).cases || []
    return recoverIndex
  }
  async function loadCase(id) {
    const want = id || rOpenCase()
    if (recoverManifest && recoverManifest.id === want) return recoverManifest
    const r = await fetch('../recover/cases/' + want + '.json', { cache: 'no-store' })
    if (!r.ok) throw new Error('no case')
    recoverManifest = await r.json()
    return recoverManifest
  }
  // '/recover d8', '/recover case-s37', '/recover S-37' all resolve against the index
  async function resolveCase(q) {
    const n = rNorm(q)
    if (!n) return null
    const idx = await loadIndex()
    return idx.find(c => rNorm(c.id) === n || rNorm(c.code) === n || rNorm(c.id) === 'case' + n) || null
  }
  async function handleCommand(t) {
    const parts = t.slice(1).trim().split(/ +/)   // plain-space split — no escapes to lose in transit
    const cmd = parts[0], arg = parts.slice(1).join(' ')
    try {
      if (cmd === 'recover' || cmd === 'case' || cmd === 'cases') {
        if (cmd === 'cases' || arg === 'list') {
          const idx = await loadIndex()
          const rows = idx.map(c => c.code + ' ' + (c.stations || []).filter(s => rSolved(c.id, s)).length + '/' + (c.stations || []).length + (c.id === rOpenCase() ? ' (open)' : ''))
          const shown = rows.slice(0, 5), more = rows.length - shown.length
          showMessage(rows.length ? shown.join(' · ') + (more > 0 ? ' · and ' + more + ' more on the board' : '') + ' — /recover <case> opens one.' : 'no cases have surfaced.')
          return
        }
        if (arg) {
          const c = await resolveCase(arg)
          if (!c) { showMessage('no case answers to that. /cases lists them.'); return }
          rSetOpenCase(c.id)
        }
        const m = await loadCase()
        const done = m.stations.filter(s => rSolved(m.id, s.id)).length
        const next = m.stations.find(s => !rSolved(m.id, s.id))
        showMessage(m.title + ' — ' + done + ' of ' + m.stations.length + ' instruments read.' + (next ? ' next: ' + next.title + '.' : ' the case is read.'))
        // a station may declare where in the maze it can be read (manifest .maze = {level | levels, hint})
        const mazeLevels = next && next.maze ? (next.maze.levels || [next.maze.level]) : []
        if (next && next.maze && next.maze.hint && mazeLevels.includes(level?.index ?? 0))
          setTimeout(() => showMessage(next.maze.hint), 2600)
      } else if (cmd === 'file') {
        if (!arg) { showMessage('file what? /file <answer>'); return }
        const m = await loadCase()
        const next = m.stations.find(s => !rSolved(m.id, s.id))
        if (!next) { showMessage('the case is already read.'); return }
        if ((await rHash(arg)) === String((next.gate && next.gate.hash) || '').toLowerCase()) {
          try { localStorage.setItem(rKey(m.id, next.id), '1') } catch (e) {}
          blip(); showMessage('filed. ' + next.title + ' — read. ' + (next.onSolve || ''))
          if (!m.stations.some(s => !rSolved(m.id, s.id)))
            setTimeout(() => showMessage(((m.reward && m.reward.key) || 'the case is read.') + ' — open the board at /recover/.'), 3000)
        } else showMessage('the file does not answer to that.')
      } else showMessage('the file does not recognise that. try /recover, /cases or /file <answer>.')
    } catch (e) { showMessage('the file could not be opened from here.') }
  }
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
  let flashAt = -1e9, flashT = 0
  function firePolaroid() {
    let dataUrl = null
    // through the renderer: a WebGL canvas is only readable when re-drawn, and the GPU backend draws on a sibling canvas, not on #c
    try { dataUrl = level?.gfx?.capture ? level.gfx.capture() : canvas.toDataURL('image/png') } catch { /* ignore */ }
    if (flashEl) {
      // A gentle ramp to a soft peak and a long decay (was: instant 90% white). Photosensitivity: a second flash
      // inside minGapMs is skipped so mashing the button cannot strobe the screen; reduceFlicker lowers it further.
      // The flash also shares the flicker limiter's budget (flashWait / noteFlash): it is held back while a light dip
      // is starting or has just started, and counts as a dip start itself, so the two never exceed 3 flashes a second.
      const fx = flashFor(renderOpts.reduceFlicker), now = performance.now()
      if (now - flashAt >= fx.minGapMs) {
        flashAt = now
        clearTimeout(flashT)
        const go = () => {
          noteFlash(fk)
          flashEl.style.transition = `opacity ${fx.attackMs}ms ease-out`; flashEl.style.opacity = String(fx.peak)
          flashT = setTimeout(() => { flashEl.style.transition = `opacity ${fx.decayMs}ms ease-in-out`; flashEl.style.opacity = '0' }, fx.attackMs)
        }
        const wait = flashWait(fk, renderOpts.reduceFlicker)
        if (wait > 0) flashT = setTimeout(go, Math.ceil(wait * 1000) + 30); else go()
      }
    }
    // the caption develops from the LIVE frame, so it works in the browser too
    // (no save bridge). A capture is a small counter-claim — it steadies you.
    const thinNear = ephemera.some(a => a.variant === 'thin' && (a.x - player.x) ** 2 + (a.y - player.y) ** 2 < 16)
    const finalizing = sanity < 40 || (level?.index ?? 0) >= 3
    sanity = Math.min(100, sanity + 8); wardPulse()
    let cap
    if (thinNear) {
      cap = 'the film shows someone who was not in the room. you can see the wall through them.'
    } else if (finalizing) {
      cap = 'the film shows the hall as it will finalize: darker, one door fewer.'
    } else {
      const g = 'iwashere'[photoIdx % 8]; photoIdx++
      cap = `the film develops one letter that was not in the room: "${g}". transcribe it.`
    }
    // still save the real evidence file on desktop; the caption shows regardless
    if (dataUrl && window.backrooms?.savePhoto) window.backrooms.savePhoto(dataUrl).catch(() => {})
    showMessage(cap)
  }

  // The radio: cosmetic hum near the surface; in the deep stacks (floors 2–3) it
  // reads the ledger aloud, one number group at a time — not talking to you,
  // reading a list, counting DOWN to your line.
  function readRadio(on) {
    const dfloor = level?.index ?? 0
    const deep = dfloor === 2 || dfloor === 3
    if (on && deep) {
      const last = stationIdx === RADIO_GROUPS.length - 1
      showMessage(`the station counts, slow and patient: ${RADIO_GROUPS[stationIdx]}${last ? '' : ' …'}   [${stationIdx + 1}/${RADIO_GROUPS.length}]`)
      blip()
      if (last) { heartbeat(); setTimeout(() => showMessage('it reads the last group, then stops. that one was yours.'), 1900) }
      stationIdx = (stationIdx + 1) % RADIO_GROUPS.length
    } else {
      showMessage(on ? 'the radio crackles to life.' : 'the radio falls silent.')
    }
  }

  // The counter-claim: fires ONCE, when the player has both typed the claim at a
  // presence AND fired the beacon registered to EXTENSION-30150A. Renderer-side,
  // so it resolves in the browser build too (no Electron bridge required).
  function tryFinale() {
    if (seamHeld || !claimFiled || !beaconFired) return
    seamHeld = true
    wardPulse(); calmTimer = 600; flickTgt = 1; flickTimer = 1.2; sanity = Math.min(100, sanity + 30)
    itemSys.grant('ballast'); renderHotbar()
    showMessage('the seam holds. the lights do not stutter. an extension that, for once, stays an extension.')
    setTimeout(() => showMessage('something answers on your channel — one voice, then the sense of others behind it. the roll call was always the living, counting themselves.'), 2600)
    setTimeout(() => showMessage("m., last page: 'walk in. do not drop in. hold the seam for the rest of us, and write your name where the dark can read it.'"), 5600)
  }

  function applyItemEffect(eff) {
    if (!eff) return
    const dfloor = level?.index ?? 0
    if (eff.type === 'almond-water') {
      if (eff.sour) {
        if (dfloor === 3) {
          sanity = Math.max(0, sanity - 14); doorSlam()
          showMessage('the water is sour, and something reads the withdrawal. a line moves in a ledger you cannot see.')
        } else {
          sanity = Math.max(0, sanity - 8); whisper(); flickTgt = 0.5; flickTimer = 0.3
          showMessage('the water is sour on your tongue. it takes something from you, and gives nothing back.')
        }
      } else {
        stamina = 100; calmTimer = 20; sanity = Math.min(100, sanity + 35); wardPulse()
        showMessage('the water is sweet. the lights steady, and so does your mind.')
      }
    } else if (eff.type === 'glowstick') {
      fogTimer = Math.max(18, 45 - Math.min(dfloor, 3) * 6); calmTimer = Math.max(calmTimer, 8); blip()
      showMessage('green light pushes at the dark — less than it used to. the crack it opens is shorter down here.')
    } else if (eff.type === 'bandage') {
      if (dfloor === 2 || dfloor === 3) {
        player.hp = Math.min(player.maxHp, player.hp + 60); calmTimer = Math.max(calmTimer, 6)
        showMessage('down here the grit under your nails is true, so the mend is true too. it holds.')
      } else {
        player.hp = Math.min(player.maxHp, player.hp + 40)
        showMessage('you patch yourself up. it holds, for now.')
      }
    } else if (eff.type === 'polaroid') {
      firePolaroid()
    } else if (eff.type === 'radio') {
      readRadio(eff.on)
    } else if (eff.type === 'plumb') {
      // the strain gauge: a grain reading that tightens with depth. A tool — it is
      // read on every press and never consumed (items.js useSelected).
      blip(); calmTimer = Math.max(calmTimer, 8)
      const grain = Math.max(0, 100 - Math.min(dfloor, 4) * 17)
      if (dfloor >= 2) { whisper(); showMessage(`the plumb reads grain ${grain}. the needle will not sit. the world is tighter here, and older.`) }
      else showMessage(`the plumb reads grain ${grain}. slack, still. it holds.`)
    } else if (eff.type === 'ballast') {
      // true floor, made present: the drop-in-thinness antidote. Never sours.
      calmTimer = 30; stamina = 100; flickTgt = 1; flickTimer = 1.2
      showMessage('you set both feet and mean it. your whole weight arrives. the dark cannot read a thing this here.')
    } else if (eff.type === 'extension-slip') {
      // 30150A — the one line the system never closed. Hands the concept, not the
      // literal claim: the phrase itself is earned from the numbers station.
      sanity = Math.min(100, sanity + 20); wardPulse()
      showMessage('notice 30150A. status: EXTENSION — the one line the system never closed. a door left ajar it cannot foreclose. make your claim where the presence waits.')
    }
    renderHotbar()
  }

  // ── ambient events (Living Atmosphere): the scheduler in events.js decides
  //    WHEN and WHICH; these are the side effects, hooked into the existing
  //    flicker / audio / message / apparition systems. ──
  function spawnCrosser() {
    const dfloor = level?.index ?? 0
    // on the deep stacks, sometimes it is not a thing but a faint drop-in — a
    // person minted thin from far away, drifting slow enough to photograph.
    const thin = (dfloor === 2 || dfloor === 3) && Math.random() < 0.3
    const ahead = 7 + Math.random() * 4                        // out in the fog ahead
    const bx = player.x + Math.cos(player.angle) * ahead
    const by = player.y + Math.sin(player.angle) * ahead
    const perp = player.angle + Math.PI / 2                     // crossing your line of sight
    const dir = Math.random() < 0.5 ? 1 : -1
    const sp = thin ? 1.1 : 2.6, span = 1.7
    ephemera.push({
      x: bx - Math.cos(perp) * dir * span, y: by - Math.sin(perp) * dir * span,
      vx: Math.cos(perp) * dir * sp, vy: Math.sin(perp) * dir * sp,
      ttl: (span * 2) / sp + 0.2, variant: thin ? 'thin' : (Math.random() < 0.5 ? 'shade' : 'lurker'),
    })
  }
  function fireEvent(id) {
    if (id === 'lights-cascade') {
      flickTgt = 0.14; flickTimer = 0.7                        // a wave of dark, held, then the loop recovers it
      showMessage('the lights go out ahead of you, one by one. then, slowly, they come back.')
    } else if (id === 'door-slam') {
      doorSlam(); shake = Math.max(shake, 0.35)
      showMessage('somewhere behind you, a door slams shut.')
    } else if (id === 'hum-stops') {
      humDuck(2.6)
      showMessage('the hum stops. the silence has a shape. then it resumes, as if something had been listening.')
    } else if (id === 'cold-spot') {
      sanity = Math.max(0, sanity - 4); whisper()
      showMessage('a cold spot. your breath fogs where there is nothing cold enough to fog it.')
    } else if (id === 'footsteps') {
      footfall()
      showMessage('footsteps. not yours. they keep your pace, and stop when you stop.')
    } else if (id === 'crosser') {
      spawnCrosser(); footfall(3); heartbeat(0.7)
      showMessage('far down the hall, something crosses the intersection. the hall is empty when you look again.')
    }
  }

  // ── vending machine: draw one item, once. Deep down the almond water it gives
  //    may be sour — the lost soul's warning, made real. ──
  function dispenseFromMachine(m) {
    if (!m || vendedSet.has(m.key)) return
    const dfloor = level?.index ?? 0
    const pool = ['almond-water', 'almond-water', 'glowstick', 'bandage']
    // Field Recovery caches surface in the deep stacks — a strain gauge, ballast, an exhibit
    if (dfloor === 2 || dfloor === 3) pool.push('plumb', 'ballast', 'extension-slip')
    const type = pool[Math.floor(Math.random() * pool.length)]
    const sour = type === 'almond-water' && dfloor >= 2 && Math.random() < 0.4
    const extra = type === 'plumb' ? { tool: true } : (sour ? { sour: true } : {})
    const res = itemSys.grant(type, extra)
    if (!res.ok) { showMessage('the machine whirs, but your hands are already full.'); return }
    vendedSet.add(m.key)
    renderHotbar(); blip()
    showMessage(`the machine clunks, and a ${ITEM_NAMES[type] ?? type} drops into the tray.`)
  }

  // ── snapshot + persistence (solo progress & inventory — the "save game") ──
  function snapshot() {
    return {
      level: level?.index ?? 0,
      x: player.x, y: player.y, angle: player.angle,
      hp: player.hp, maxHp: player.maxHp,
      inventory: itemSys.inventory.map(i => ({ type: i.type, ...(i.on ? { on: true } : {}) })),
      selected: itemSys.selected,
      pagesRead: [...readSet],
      worldSeed, anchor,
    }
  }
  let saveTimer = 0
  const persist = () => { if (!mpClient) writeSave(snapshot()) }   // solo runs are the ones you resume
  window.addEventListener('beforeunload', persist)

  // ── boot: resume a saved run, else a fresh SOLO run enters through Level ∅
  //    (the block — index 4), while online play starts in the lobby together. ──
  if (resume) {
    buildLevel(resume.level ?? 0)
    player.x = resume.x ?? player.x
    player.y = resume.y ?? player.y
    player.angle = resume.angle ?? 0
    player.maxHp = resume.maxHp ?? 100
    player.hp = resume.hp ?? player.maxHp
    if (Array.isArray(resume.pagesRead)) for (const f of resume.pagesRead) if (Number.isInteger(f) && f >= 0 && f < SCRAPS.length) readSet.add(f)
    if (Array.isArray(resume.inventory)) {
      itemSys.inventory.length = 0
      for (const it of resume.inventory) itemSys.inventory.push({ type: it.type, ...(it.on ? { on: true } : {}) })
      itemSys.select(Math.max(0, Math.min(5, resume.selected ?? 0)))
      renderHotbar()
    }
  } else {
    buildLevel(mpClient ? 0 : 4)   // solo: fall in through the block (∅); online: the lobby
  }
  showMessage(level.cfg.levelName)

  // apply saved audio/visual prefs, then keep them live as the panel changes them
  setMusicEnabled(getPref('music'))
  setMusicVolume(getPref('musicVolume'))
  setAmbienceVolume(getPref('ambienceVolume'))   // volume before the toggle, so the first ramp lands on the right level
  setAmbience(getPref('ambience'))
  onPrefChange((k, v) => {
    if (k === 'grain')          renderOpts.grain = v
    else if (k === 'particles') renderOpts.particles = v
    else if (k === 'crosshair') renderOpts.crosshair = v
    else if (k === 'reduceFlicker') renderOpts.reduceFlicker = v
    else if (k === 'renderer') { renderOpts.renderer = v; if (level && level.gfx) { try { level.gfx.dispose() } catch { /* ignore */ } level.gfx = makeGfx(level.cfg, level.cache) } }   // rebuilt now, not at the next level
    else if (k === 'fpsCap')    { fpsCap = v; qd.setPrefs({ fpsCap: v }) }
    else if (k === 'graphicsQuality' || k === 'hiDpi') { if (qd.setPrefs({ [k]: v })) queueResize() }     // laid out by the next frame that draws
    else if (k === 'music')     setMusicEnabled(v)
    else if (k === 'musicVolume') setMusicVolume(v)
    else if (k === 'ambience')  setAmbience(v)
    else if (k === 'ambienceVolume') setAmbienceVolume(v)
    // mouseSensitivity, headBob, creatures and damage are read live each frame
  })

  // ?gfxstats=1: the diagnostics panel (gfx-stats.js) — created only when asked for; otherwise nothing, no timer, no element
  const gfxStats = statsEnabled(location.search) ? createStatsOverlay({
    doc: document, parent: document.getElementById('hud-cluster'),
    read: () => {
      const g = level.gfx, t = renderOpts.qualityTier
      return {
        kind: g.kind, why: g.why, info: g.info, fallbacks: g.fallbacks, tier: t, scale: renderOpts.renderScale ?? qualityFor(t).scale,
        canvasW: canvas.width, canvasH: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight, dpr: window.devicePixelRatio, levelStart,
      }
    },
  }) : null

  const entityAsm = createEntityAssembler(), EF = ENTITY_FILLS
  let last = 0
  let frameCount = 0
  let loopErrs = 0
  // time plumbing: `dt` below is the CLAMPED simulation step; `rawMs` is the real interval between processed frames,
  // which the quality controller and the renderer's animation clock need (a clamped dt hides an overloaded machine)
  const pacer = createFramePacer()
  const timing = { t: 0, dt: 1 / 60 }     // handed to render(): seconds since the first frame / real frame time (capped at 0.1 s)
  let t0 = -1, lastWorkMs = 0
  function loop(ts) {
   try {
    // fpsCap: skip frames on the raw timestamp; a pending layout (at most one per frame, however many events came in) only on a frame that draws
    if (!frameDue(ts, pacer, fpsCap, resizeGate, resize)) { requestAnimationFrame(loop); return }
    const w0 = performance.now()
    const rawMs = last > 0 ? ts - last : 1000 / 60
    if (t0 < 0) t0 = ts
    const dt = Math.min(rawMs / 1000, 0.05)
    last = ts
    timing.t = (ts - t0) / 1000; timing.dt = Math.min(rawMs / 1000, 0.1)
    if (qd.frame(rawMs, lastWorkMs)) qd.apply(renderOpts)                 // adaptive resolution: down fast, up slowly
    // the GPU health monitor watches the REAL frame interval (a CPU-side timer cannot see GPU time); it only acts once the resolution is at its floor
    if (level.gfx.kind === 'gpu') level.gfx.noteFrame(rawMs, { budgetMs: 1000 / (fpsCap > 0 ? fpsCap : 60), atFloor: qd.state.atFloor })
    if (frameCount % 120 === 0 && window.devicePixelRatio !== lastDpr) resize()   // the window moved to another display
    const cfg = level.cfg

    // ── flicker (per-level tuning) — rate-limited: at most 3 dips a second (WCAG 2.3.1), depth-capped under
    //    reduceFlicker. The state machine is gfx-quality.js stepFlicker; events and items that write flickTgt /
    //    flickTimer directly (lights-cascade, sour water, ...) are vetted by it on the next step. ──
    const fl = cfg.flicker
    const calm = calmTimer > 0
    if (calm) calmTimer -= dt
    fk.value = flicker; fk.target = flickTgt; fk.timer = flickTimer
    stepFlicker(fk, dt, fl, Math.random, calm, renderOpts.reduceFlicker)
    flicker = fk.value; flickTgt = fk.target; flickTimer = fk.timer
    setFlicker(flicker)

    // ── movement (frozen during a transition fade or while typing in chat) ──
    let moved = false
    if (!transitioning && !chatOpen && !noteOpen) {
      const wantSprint = (K['ShiftLeft'] || K['ShiftRight']) && stamina > 0
      const mult = wantSprint ? 1.8 : 1
      const sp = SPEED * dt * 60 * mult
      const ca = Math.cos(player.angle), sa = Math.sin(player.angle)
      if (K['KeyW'] || K['ArrowUp'])   { tryMove(player.x + ca * sp, player.y + sa * sp); moved = true }
      if (K['KeyS'] || K['ArrowDown']) { tryMove(player.x - ca * sp * 0.6, player.y - sa * sp * 0.6); moved = true }
      if (K['KeyA'])                   { tryMove(player.x + Math.cos(player.angle - Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle - Math.PI/2) * sp * 0.7); moved = true }
      if (K['KeyD'])                   { tryMove(player.x + Math.cos(player.angle + Math.PI/2) * sp * 0.7, player.y + Math.sin(player.angle + Math.PI/2) * sp * 0.7); moved = true }
      if (!locked && K['ArrowLeft'])  player.angle -= 0.04 * dt * 60   // dt-scaled: a 144 Hz display turns at the same rate
      if (!locked && K['ArrowRight']) player.angle += 0.04 * dt * 60
      if (moved && wantSprint) stamina = Math.max(0, stamina - 22 * dt)
      else                     stamina = Math.min(100, stamina + 9 * dt)
    }
    player.moving = moved
    if (moved) player.bob += 0.12 * dt * 60
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

    // ── Living Atmosphere: occasional ambient dread events (procedural floors only) ──
    const evCanFire = !transitioning && !dialogOpen && !chatOpen && !noteOpen && level.index >= 0 && level.index <= 3
    const evId = eventSched.tick(dt, { level: level.index, sanity, canFire: evCanFire })
    if (evId) fireEvent(evId)

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
    const nearScrap = level.decor.nearestScrap(player.x, player.y, 1.8)
    const nearMachine = level.decor.nearestMachine(player.x, player.y, 1.6)

    const itemHintEl = document.getElementById('item-hint')
    if (itemHintEl) {
      if (nearItem) {
        itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}`
        itemHintEl.style.opacity = '1'
      } else if (nearMachine && !vendedSet.has(nearMachine.key)) {
        itemHintEl.textContent = 'f · draw from the machine'
        itemHintEl.style.opacity = '1'
      } else if (nearExit) {
        itemHintEl.textContent = `f · ${cfg.exit?.label ?? 'descend'}`
        itemHintEl.style.opacity = '1'
      } else if (nearScrap) {
        itemHintEl.textContent = 'e · read the scrap'
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

    // reading a scrap freezes play; any action key or Esc puts it back (works
    // for touch too — the SPEAK/ACT/WARD buttons set these keys)
    if (noteOpen && (K['Escape'] || K['KeyE'] || K['KeyF'] || K['Space'] || K['Enter'] || K['NumpadEnter'])) {
      K['Escape'] = K['KeyE'] = K['KeyF'] = K['Space'] = K['Enter'] = K['NumpadEnter'] = false
      closeNoteCard()
    }

    // Enter opens chat when connected to others
    if (!chatOpen && !dialogOpen && !noteOpen && (K['Enter'] || K['NumpadEnter'])) {
      K['Enter'] = false; K['NumpadEnter'] = false; openChat()
    }

    if (!transitioning && !dialogOpen && !chatOpen && !noteOpen) {
      // F — item first, else exit
      if (K['KeyF']) {
        K['KeyF'] = false
        if (nearItem) {
          const res = itemSys.pickUp(nearItem.key)
          if (res.ok) showMessage(`you take the ${ITEM_NAMES[res.item.type] ?? res.item.type}.`)
          else if (res.reason === 'full') showMessage('your hands are full.')
          renderHotbar()
        } else if (nearMachine && !vendedSet.has(nearMachine.key)) {
          dispenseFromMachine(nearMachine)
        } else if (nearExit) {
          descend(nearExit.target, cfg.exit?.label)
        }
      }
      if (K['KeyQ']) { K['KeyQ'] = false; applyItemEffect(itemSys.useSelected()) }
      if (K['KeyX']) { K['KeyX'] = false; discardSelected() }
      if (K['KeyM']) { K['KeyM'] = false; const on = !getPref('music'); setPref('music', on); showMessage(on ? 'the music seeps back in.' : 'the music stops.') }
      if (K['KeyN']) { K['KeyN'] = false; cycleTrack() }
      if (K['KeyL']) { K['KeyL'] = false; flashlight = !flashlight; showMessage(flashlight ? 'flashlight on.' : 'flashlight off — the dark leans in.') }
      if (K['KeyB']) {
        K['KeyB'] = false
        const effect = getPref('beaconEffect')
        const target = (getPref('beaconWebhook') || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const counterClaim = target.includes('extension30150a')
        if (!effect || effect === 'off') {
          showMessage('no beacon set. register one in settings.')
        } else {
          showMessage(counterClaim
            ? 'you fire the beacon — not a cry for help. a claim. i was here. put it in the file.'
            : 'you push the beacon into the dark...')
          // fire the real webhook on desktop; the counter-claim resolves renderer-side either way
          const p = window.backrooms?.fireBeacon?.({ effect, webhook: getPref('beaconWebhook') })
          if (p) p.then(r => showMessage(
                    r?.ok ? 'something answers.'
                  : r?.reason === 'cooldown' ? 'the beacon is still warm.'
                  : 'the beacon goes quiet.'))
                 .catch(() => showMessage('the beacon goes quiet.'))
          else if (!counterClaim) showMessage('the beacon goes quiet.')
          if (counterClaim) { beaconFired = true; tryFinale() }
        }
      }
      for (let i = 0; i < 6; i++) {
        const code = `Digit${i + 1}`
        if (K[code]) { K[code] = false; itemSys.select(i); renderHotbar() }
      }
      if (K['KeyE']) {
        K['KeyE'] = false
        if (nearPresence) openDialog()
        else if (nearScrap) openNoteCard(nearScrap)
        else if (nearNpc) showMessage(NPC_LINES[Math.floor(Math.random() * NPC_LINES.length)])
      }
      // Space — the ward: a shove of will and light. Knocks the things back and
      // leaves them reeling; ward one enough times and it comes apart. Costs legs.
      if (K['Space']) {
        K['Space'] = false
        if (wardCd <= 0) {
          if (stamina >= 20) {
            stamina -= 20; wardCd = 0.65
            const res = getPref('creatures') ? level.entitySys.ward(player) : { hit: 0, dispelled: 0 }
            wardPulse(); shake = Math.max(shake, 0.45)
            if      (res.dispelled > 0) showMessage(res.dispelled > 1 ? 'they come apart in the light.' : 'it comes apart in the light.')
            else if (res.hit > 0)       showMessage(res.hit > 1 ? 'they recoil from you.' : 'it recoils from you.')
            else                        showMessage('you push at the dark. it gives nothing back.')
          } else showMessage('nothing left in your legs to push with.')
        }
      }
    }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // ── stream world + subsystems around the player ──
    level.cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)
    level.decor.update(pcx, pcy)
    netTimer += dt
    if (mpClient?.isConnected() && netTimer >= 0.05) { netTimer = 0; mpClient.sendPos(player.x, player.y, player.angle, player.hp) }
    // creatures can be switched off entirely (pure liminal exploration)
    const creaturesOn = getPref('creatures')
    if (creaturesOn) level.entitySys.update(dt, player, pcx, pcy, radioOn ? 1.5 : 1)

    // ── nearest stalker (drives contact damage, the heartbeat, and sanity) ──
    let nearD2 = Infinity
    const creaturesLive = creaturesOn && cfg.entities?.enabled
    if (creaturesLive) {
      for (const e of level.entitySys.getEntities()) {
        if (e.type !== 'stalker') continue
        if (e.stagger > 0) continue        // reeling from a ward — cannot reach you
        const d2 = (e.x - player.x) ** 2 + (e.y - player.y) ** 2
        if (d2 < nearD2) nearD2 = d2
      }
    }
    const nearD = Math.sqrt(nearD2)

    // ── HP: contact damage, i-frames, delayed regen, death ──
    if (invuln > 0) invuln -= dt
    if (wardCd > 0) wardCd -= dt
    if (!transitioning && creaturesLive && getPref('damage') && invuln <= 0 && nearD < 0.62) {
      player.hp -= (cfg.entities.damage ?? 16); invuln = 0.7; hurt = 1; regenDelay = 6; shake = 1
      showMessage('it has you.')
    }
    if (regenDelay > 0) regenDelay -= dt
    else if (player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + 3.5 * dt)
    if (hurt > 0) hurt = Math.max(0, hurt - dt * 2)
    const hurtEl = document.getElementById('hurt')
    if (hurtEl) hurtEl.style.opacity = (hurt * 0.55).toFixed(2)
    if (player.hp <= 0) { player.hp = 0; die() }

    // ── heartbeat — quickens as something closes in ──
    if (!transitioning && creaturesLive && nearD < 12) {
      heartT -= dt
      if (heartT <= 0) { const prox = 1 - nearD / 12; heartbeat(0.5 + prox); heartT = 1.15 - prox * 0.8 }
    } else heartT = 0

    // ── sanity — dark + the hunt drain it; light, almond water, a friend restore it ──
    let sdelta = flashlight ? 2 : -2
    sdelta -= level.index * 0.5
    if (nearD < 10) sdelta -= 4
    if (mpClient) { for (const rp of mpClient.getRemotePlayers()) { if ((rp.x - player.x) ** 2 + (rp.y - player.y) ** 2 < 36) { sdelta += 3; break } } }
    sanity = Math.max(0, Math.min(100, sanity + sdelta * dt))
    updateSanity()
    const insane = Math.max(0, Math.min(1, (42 - sanity) / 42))
    if (insaneEl) insaneEl.style.opacity = (insane * 0.6).toFixed(2)
    if (insane > 0.25 && !transitioning) { sanWhisperT -= dt; if (sanWhisperT <= 0) { whisper(); sanWhisperT = 3 + Math.random() * 6 } }

    // ── screen shake (decays) ──
    if (shake > 0.01) {
      shake = Math.max(0, shake - dt * 3)
      const m = shake * 8 * (renderOpts.reduceFlicker ? 0.25 : 1)     // reduce flicker / reduced motion: a quarter of the shake
      canvas.style.transform = `translate(${((Math.random() - 0.5) * m).toFixed(1)}px, ${((Math.random() - 0.5) * m).toFixed(1)}px)`
    } else if (canvas.style.transform) canvas.style.transform = ''

    // ── assemble sprites and render ──
    // advance any event apparitions (render-only; no collision or damage)
    for (let i = ephemera.length - 1; i >= 0; i--) {
      const a = ephemera[i]; a.x += a.vx * dt; a.y += a.vy * dt; a.ttl -= dt
      if (a.ttl <= 0) ephemera.splice(i, 1)
    }
    // one flat list in this order: enemies (as-is), remote players, npcs, props, exits, items, notes, machines, sights, apparitions — built
    // from pooled records every frame instead of fresh objects (createEntityAssembler: same fields, same values, same order as before)
    entityAsm.begin()
    if (creaturesOn) entityAsm.pass(level.entitySys.getEntities())
    if (mpClient) entityAsm.add('player', mpClient.getRemotePlayers(), EF.player)
    entityAsm.add('npc', level.decor.getNpcs(), EF.npc)
    entityAsm.add('prop', level.decor.getProps(), EF.prop)
    entityAsm.add('exit', level.decor.getExits(), EF.exit)
    entityAsm.add('item', itemSys.getWorldItems(), EF.item)
    entityAsm.add('note', level.decor.getScraps(), EF.note, readSet)
    entityAsm.add('machine', level.decor.getMachines(), EF.machine, vendedSet)
    entityAsm.add('sight', level.decor.getSights(), EF.sight)
    entityAsm.add('apparition', ephemera, EF.apparition)
    const allEntities = entityAsm.end()

    const r0 = performance.now()
    // the wall test declares the chunk it hands the cache (and the cache's evict radius), which lets the rays' per-frame isWall memo stay on
    // (gfx-world.js memoSafe); an undeclared closure renders the same pixels, only slower
    const wallFn = (wx, wy) => level.cache.isWall(wx, wy, pcx, pcy)
    wallFn.pcx = pcx; wallFn.pcy = pcy; wallFn.evictRadius = level.cfg.chunkEvictRadius ?? 3
    level.gfx.render(player, wallFn, flicker, allEntities, fogMul,
      { flashlight, glow: fogTimer > 0 ? [80, 235, 110] : null }, timing)
    const r1 = performance.now()
    frameCount++
    if (levelStart && levelStart.frames++ === 0) {
      levelStart.firstMs = r1 - r0; levelStart.readyMs = r1 - levelStart.t0
      if (gfxStats) { try { console.info(`[renderer] level ${levelStart.level} start: build ${levelStart.buildMs.toFixed(1)} ms (renderer ${levelStart.gfxMs.toFixed(1)}), first frame ${levelStart.firstMs.toFixed(1)} ms, ready after ${levelStart.readyMs.toFixed(1)} ms`) } catch { /* ignore */ } }
    }
    if (gfxStats) gfxStats.frame(rawMs, r1 - r0)
    lastWorkMs = performance.now() - w0                                   // this frame's callback cost: the controller's headroom signal
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
