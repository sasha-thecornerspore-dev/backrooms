// src/renderer/touch.js — on-screen touch controls for phones / ChromeOS tablets.
//
// A progressive enhancement: it only activates on touch devices, so desktop +
// keyboard play is completely unaffected. It feeds the SAME input channels the
// keyboard already uses — it writes movement into the `K` keymap and rotates
// `player.angle` directly — so NO gameplay logic changes. Action buttons just
// set the key the game loop already consumes (F take/descend, Q use, E speak,
// L light, Space ward), so behaviour stays identical to pressing the key.
// The ward is the one verb with a hold: for the codes named in the optional
// `edges` option ({ Space: { press, release } }) the button also counts its
// press and release edges (ward.js reads the counts, so a tap that starts and
// ends inside one frame still lands), and clears the key on release — the loop
// no longer edge-consumes Space, and K['Space'] must not stay down for ever.
//
// Two more buttons come and go (I5): TYPE (Enter) and BEACON (B), each shown only while its key would do something — game.js tells
// show(line, beacon) once a frame, and nothing is touched unless the answer changes. TYPE runs the game's own Enter (the `taps`
// option) inside the finger's lift, so the line's input is focused inside the gesture and the phone's keyboard comes up; BEACON is a
// plain key button like the six. The discs are placed by placeDiscs from the bottom-right corner up, wrapping into columns to the
// left, clear of the page's other controls (measured on mount, on a resize and when the set changes — never per frame).
//
// The pure input math (stickToKeys, lookYaw), the two conditions (beaconShown, lineShown) and the layout (placeDiscs) are
// unit-tested; the DOM/event layer is a thin adapter over them.

export function isTouchDevice() {
  if (typeof window === 'undefined') return false
  return ('ontouchstart' in window) ||
    (navigator.maxTouchPoints > 0) ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
}

// ── pure input math ──

// Map a joystick displacement (dx,dy px from centre; +y is DOWN on screen) to
// the WASD key booleans. Below the deadzone → all false. Forward is up
// (dy < 0). A key engages once the push is more than `lat` off the cross-axis,
// so straight pushes don't smear into diagonals but real diagonals still work.
// Pushing near the rim while going forward engages sprint (ShiftLeft).
export function stickToKeys(dx, dy, radius, opts = {}) {
  const keys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, ShiftLeft: false }
  const dead = (opts.deadzone ?? 0.28) * radius
  const sprintAt = (opts.sprintAt ?? 0.92) * radius
  const lat = opts.lateral ?? 0.38
  const mag = Math.hypot(dx, dy)
  if (mag < dead || mag === 0) return keys
  const ux = dx / mag, uy = dy / mag
  if (uy < -lat) keys.KeyW = true
  if (uy > lat) keys.KeyS = true
  if (ux < -lat) keys.KeyA = true
  if (ux > lat) keys.KeyD = true
  if (mag >= sprintAt && keys.KeyW) keys.ShiftLeft = true
  return keys
}

// Yaw (radians) to add per horizontal drag-pixel. Mirrors the mouse-look scale,
// tuned a touch higher for finger drags. `sens` is the mouseSensitivity pref.
export function lookYaw(dx, sens) {
  return dx * 0.0055 * ((sens ?? 100) / 100)
}

// ── DOM / event adapter ──

const MOVE_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']

// Buttons that map 1:1 to a key the game loop already edge-consumes.
export const ACTIONS = [
  { code: 'KeyF', label: 'ACT', hint: 'take · descend' },
  { code: 'KeyQ', label: 'USE', hint: 'use item' },
  { code: 'Space', label: 'WARD', hint: 'push back' },
  { code: 'KeyE', label: 'SPEAK', hint: 'talk · wish' },
  { code: 'KeyL', label: 'LIGHT', hint: 'flashlight' },
  { code: 'KeyC', label: 'CALL', hint: 'whistle' },
]

// The two that come and go, after the six (so one appearing never moves another), each shown only while its key would do something:
//   TYPE   (Enter) the line — the chat in a room, the field console alone (game.js openChat: the input doubles as the console)
//   BEACON (B)     a beacon pushed out of the maze, once one is set in settings (and the counter-claim, which rides the same push)
export const SITUATIONAL = [
  { code: 'Enter', label: 'TYPE', hint: 'chat · console' },
  { code: 'KeyB', label: 'BEACON', hint: 'send a signal' },
]

// TYPE alone too: the console answers solo, and its cases are what a phone could not reach. false keeps TYPE to rooms (the chat)
export const TYPE_ALONE = true

// BEACON: B pushes a beacon only once one is set — compose-gates.js beaconDecision fires whenever the effect is not 'off' (the
// counter-claim with it) — and only while the verbs are live (no card, map, wish box, line or fade, and not lying down: game.js
// sweeps B then). `verbsLive` is game.js's own reading of that
export function beaconShown(effect, verbsLive) {
  return !!verbsLive && !!effect && effect !== 'off'
}

// TYPE: Enter opens the line whenever no card, wish box or line is already up (game.js's Enter branch, `lineFree`), in a room for the
// chat, or alone for the console
export function lineShown(lineFree, room, alone = TYPE_ALONE) {
  return !!lineFree && (!!room || !!alone)
}

// ── the layout (css px): the stack's corner (right, bottom: the flex stack's own offsets), the screen margins it never crosses, the gap
//    between discs, the clearance kept from every other control, how far a column's foot may rise over something along the bottom (a
//    dock of slots, never the stick), and the two disc sizes ──
export const LAYOUT = { right: 20, bottom: 30, top: 12, left: 8, gap: 12, clear: 6, lift: 36, act: 84, disc: 66 }

// the topmost of the keep-out rects ({ x, y, r, b }) within `c` of the square (x, y, s), or null
function blocker(x, y, s, keep, c) {
  let top = null
  for (let k = 0; k < keep.length; k++) {
    const r = keep[k]
    if (x < r.r + c && x + s > r.x - c && y < r.b + c && y + s > r.y - c && (top === null || r.y < top.y)) top = r
  }
  return top
}

// the top of a column's first disc (size s, the column's right edge `right`): at the foot, or lifted over whatever lies along the bottom
// there by no more than L.lift; null when that is not enough (the column is no use)
function foot(right, s, h, keep, L) {
  const x = right - s, low = h - L.bottom - s
  let y = low
  for (;;) {
    if (y < L.top || low - y > L.lift) return null
    const hit = blocker(x, y, s, keep, L.clear)
    if (hit === null) return y
    y = hit.y - L.clear - s
  }
}

// Place discs of the given diameters (in order: ACT first, in the corner) from the bottom-right corner up, right-aligned, wrapping into
// columns to the left — the flex stack's own order — each kept L.clear off every keep-out rect ({ x, y, r, b }: the stick, the gear,
// the map corner, the gauges, the item slots and ✕). A column starts at its foot (lifted over a dock along the bottom, see foot); it
// ends where its next disc would meet something above it or the top margin, and the next starts to its left. The discs from index
// `extras` on (the two that come and go) stand in a column of their own beside the stack when that column's foot is free, so they never
// climb over the centre of the screen; where it is not (the stick takes it), they carry on up the stack's last column.
// out[i] = { x, y } (top-left), or null when the screen has no room left. Returns how many were placed. Pure; it allocates only
// out's records (it runs on a resize or a change of set, never per frame).
export function placeDiscs(w, h, sizes, keep, out, extras = sizes.length, L = LAYOUT) {
  out.length = sizes.length
  let right = w - L.right, width = 0, bottom = 0, n = 0, placed = 0
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i]
    out[i] = null
    if (i === extras && n > 0) {                                                   // the extras' own column, if its foot is free
      const r2 = right - width - L.gap
      if (r2 - s >= L.left && foot(r2, s, h, keep, L) !== null) { right = r2; width = 0; n = 0 }
    }
    for (;;) {
      const x = right - s
      if (x < L.left) break                                                        // off the left edge: no room for this one
      const y = n === 0 ? foot(right, s, h, keep, L) : bottom - s
      if (y !== null && y >= L.top && (n === 0 || blocker(x, y, s, keep, L.clear) === null)) {
        out[i] = { x, y }; placed++; n++; if (s > width) width = s; bottom = y - L.gap; break
      }
      right -= (n > 0 ? width : s) + L.gap; width = 0; n = 0                       // the next column, to the left
    }
  }
  return placed
}

// the page's other controls the discs keep clear of (with the stick, which touch.js owns): the gear, the map's paper corner, the
// gauges, the item slots and ✕ — wherever the page's CSS has put them at this size
const KEEP_OUT = '#btn-settings, #map-tab, #hud-plate, #hotbar .slot, #btn-discard'

const CSS = `
#touch-ui { position: fixed; inset: 0; z-index: 46; pointer-events: none;
  touch-action: none; -webkit-user-select: none; user-select: none; font-family: 'Courier New', monospace; }
#touch-look { position: absolute; inset: 0; pointer-events: auto; touch-action: none; z-index: 1; }
#touch-stick { position: absolute; left: 26px; bottom: 26px; width: 132px; height: 132px;
  border-radius: 50%; border: 2px solid rgba(201,186,114,0.45); background: rgba(20,16,6,0.28);
  pointer-events: auto; touch-action: none; z-index: 3; }
#touch-knob { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px;
  border-radius: 50%; background: rgba(201,186,114,0.5); border: 2px solid rgba(42,30,0,0.6);
  transition: transform 0.04s linear; }
#touch-actions { position: absolute; right: 20px; bottom: 30px; display: flex; flex-direction: column-reverse;
  gap: 12px; flex-wrap: wrap-reverse; max-height: calc(100vh - 60px); align-content: flex-end; column-gap: 12px;
  pointer-events: none; z-index: 3; }
.touch-btn { width: 66px; height: 66px; border-radius: 50%; pointer-events: auto; touch-action: none;
  background: rgba(20,16,6,0.42); border: 2px solid rgba(201,186,114,0.5); color: #e8d9a0;
  font: bold 12px 'Courier New', monospace; letter-spacing: 1px; display: flex; align-items: center;
  justify-content: center; text-align: center; }
.touch-btn.act { width: 84px; height: 84px; font-size: 14px; border-color: rgba(201,186,114,0.8); }
.touch-btn.down { background: rgba(90,72,16,0.7); transform: scale(0.94); }
.touch-btn.off { display: none; }
#touch-actions.placed { inset: 0; display: block; max-height: none; }
#touch-actions.placed .touch-btn { position: absolute; }
`

export function initTouchControls({ canvas, K, player, getPref, edges = null, taps = null } = {}) {
  if (!isTouchDevice() || typeof document === 'undefined') return null
  if (document.getElementById('touch-ui')) return null   // already mounted

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const ui = document.createElement('div'); ui.id = 'touch-ui'
  const look = document.createElement('div'); look.id = 'touch-look'
  const stick = document.createElement('div'); stick.id = 'touch-stick'
  const knob = document.createElement('div'); knob.id = 'touch-knob'
  stick.appendChild(knob)
  const actions = document.createElement('div'); actions.id = 'touch-actions'
  const buttons = [], on = []               // every disc in order (the six, then TYPE and BEACON), and whether it is shown
  for (const a of ACTIONS.concat(SITUATIONAL)) {
    const b = document.createElement('div')
    const situational = SITUATIONAL.includes(a)
    b.className = 'touch-btn' + (a.code === 'KeyF' ? ' act' : '') + (situational ? ' off' : '')   // the two start hidden
    b.textContent = a.label
    b.dataset.code = a.code
    b.title = a.hint
    actions.appendChild(b)
    buttons.push(b); on.push(!situational)
  }
  ui.append(look, stick, actions)
  document.body.appendChild(ui)

  // ── the layout: the shown discs through placeDiscs, over the page's other controls as they stand now. Run on mount, on a resize or a
  //    turn of the phone, when a control above the dock changes size (a ResizeObserver on the gauges, the map corner — gone on the block
  //    — and the slots; never the compass line, which changes as you walk) and when the set changes. Any failure leaves the CSS flex
  //    stack (the fallback) as it was ──
  const keep = [], sizes = [], shown = [], spots = []
  const pushRect = (el) => {
    const r = el.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) keep.push({ x: r.left, y: r.top, r: r.right, b: r.bottom })
  }
  function relayout() {
    try {
      const W = window.innerWidth, H = window.innerHeight
      if (!(W > 0 && H > 0) || typeof document.querySelectorAll !== 'function') return
      keep.length = 0; sizes.length = 0; shown.length = 0
      pushRect(stick)
      for (const el of document.querySelectorAll(KEEP_OUT)) pushRect(el)
      let six = 0
      for (let i = 0; i < buttons.length; i++) if (on[i]) { shown.push(buttons[i]); sizes.push(buttons[i].dataset.code === 'KeyF' ? LAYOUT.act : LAYOUT.disc); if (i < ACTIONS.length) six++ }
      placeDiscs(W, H, sizes, keep, spots, six)                                   // TYPE and BEACON: their own column when they can
      for (let i = 0; i < shown.length; i++) {
        const p = spots[i], b = shown[i]
        if (p) { b.style.left = p.x + 'px'; b.style.top = p.y + 'px'; b.style.visibility = '' }
        else b.style.visibility = 'hidden'             // no room on this screen: hidden, never on top of another control
      }
      actions.classList.add('placed')
    } catch { /* the flex stack stays */ }
  }
  relayout()
  window.addEventListener('resize', relayout)
  window.addEventListener('orientationchange', relayout)
  let watch = null
  if (typeof ResizeObserver === 'function') {
    watch = new ResizeObserver(() => relayout())
    for (const id of ['hud-plate', 'map-tab', 'hotbar']) { const el = document.getElementById(id); if (el) watch.observe(el) }
  }

  // show(line, beacon): TYPE and BEACON, each shown only while its key would do something (game.js, once a frame). Nothing moves unless
  // the answer changes; a disc that goes away lets go of its press (a BEACON tap still waiting for the loop never lands later)
  let mask = 0
  function show(line, beacon) {
    const want = (line ? 1 : 0) | (beacon ? 2 : 0)
    if (want === mask) return
    mask = want
    for (let j = 0; j < SITUATIONAL.length; j++) {
      const i = ACTIONS.length + j, b = buttons[i], want1 = ((mask >> j) & 1) === 1
      if (want1 === on[i]) continue
      on[i] = want1
      if (want1) b.classList.remove('off')
      else { b.classList.add('off'); b.classList.remove('down'); if (!(taps && typeof taps[b.dataset.code] === 'function')) K[b.dataset.code] = false }
    }
    relayout()
  }

  const RADIUS = 66
  const sens = () => (typeof getPref === 'function' ? (getPref('mouseSensitivity') || 100) : 100)

  let moveId = null            // touch identifier driving the stick
  let lookId = null, lookX = 0 // touch identifier driving the look, last x

  const clearMove = () => { for (const k of MOVE_KEYS) K[k] = false; knob.style.transform = '' }

  function setStick(clientX, clientY) {
    const r = stick.getBoundingClientRect()
    let dx = clientX - (r.left + r.width / 2)
    let dy = clientY - (r.top + r.height / 2)
    const mag = Math.hypot(dx, dy)
    const clamp = Math.min(mag, RADIUS)
    const kx = mag ? (dx / mag) * clamp : 0
    const ky = mag ? (dy / mag) * clamp : 0
    knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`
    const keys = stickToKeys(dx, dy, RADIUS)
    for (const k of MOVE_KEYS) K[k] = keys[k]
  }

  // stick
  stick.addEventListener('touchstart', (e) => {
    if (moveId !== null) return
    const t = e.changedTouches[0]
    moveId = t.identifier
    setStick(t.clientX, t.clientY)
    e.preventDefault()
  }, { passive: false })

  // look (drag anywhere on the open field)
  look.addEventListener('touchstart', (e) => {
    if (lookId !== null) return
    const t = e.changedTouches[0]
    lookId = t.identifier; lookX = t.clientX
    e.preventDefault()
  }, { passive: false })

  // action buttons — set the key the loop consumes; visual press feedback. An edge-counted code (the WARD button) also moves its
  // press count on touchstart and its release count on touchend / touchcancel, and lets go of the key then (the note card still
  // closes on the K['Space'] it saw while the finger was down). A code named in `taps` (TYPE's Enter) sets no key: its function runs
  // on the lift instead (touchend, an activation-triggering event: the input it focuses brings up the phone's keyboard), never on a
  // touchcancel. touchstart's preventDefault keeps the synthesized mouse events from taking that focus straight back
  for (const b of buttons) {
    const code = b.dataset.code
    const edge = edges && edges[code] ? edges[code] : null
    const tap = taps && typeof taps[code] === 'function' ? taps[code] : null
    b.addEventListener('touchstart', (e) => {
      if (!tap) K[code] = true
      if (edge) edge.press++
      b.classList.add('down')
      e.preventDefault(); e.stopPropagation()
    }, { passive: false })
    const up = () => { b.classList.remove('down'); if (edge) { edge.release++; K[code] = false } }
    b.addEventListener('touchend', tap ? () => { up(); tap() } : up)
    b.addEventListener('touchcancel', up)
  }

  // global move/end routing by identifier (a finger can slide off its origin)
  window.addEventListener('touchmove', (e) => {
    let handled = false
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { setStick(t.clientX, t.clientY); handled = true }
      else if (t.identifier === lookId) {
        player.angle += lookYaw(t.clientX - lookX, sens()); lookX = t.clientX; handled = true
      }
    }
    if (handled) e.preventDefault()
  }, { passive: false })

  function endTouch(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; clearMove() }
      else if (t.identifier === lookId) { lookId = null }
    }
  }
  window.addEventListener('touchend', endTouch)
  window.addEventListener('touchcancel', endTouch)

  return {
    el: ui, show,
    destroy: () => {
      watch?.disconnect()
      window.removeEventListener('resize', relayout); window.removeEventListener('orientationchange', relayout)
      ui.remove(); style.remove()
    },
  }
}
