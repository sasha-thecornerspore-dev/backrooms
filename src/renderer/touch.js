// src/renderer/touch.js — on-screen touch controls for phones / ChromeOS tablets.
//
// A progressive enhancement: it only activates on touch devices, so desktop +
// keyboard play is completely unaffected. It feeds the SAME input channels the
// keyboard already uses — it writes movement into the `K` keymap and rotates
// `player.angle` directly — so NO gameplay logic changes. Action buttons just
// set the key the game loop already consumes (F take/descend, Q use, E speak,
// L light, Space ward), so behaviour stays identical to pressing the key.
//
// The pure input math (stickToKeys, lookYaw) is unit-tested; the DOM/event
// layer is a thin adapter over it.

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
const ACTIONS = [
  { code: 'KeyF', label: 'ACT', hint: 'take · descend' },
  { code: 'KeyQ', label: 'USE', hint: 'use item' },
  { code: 'Space', label: 'WARD', hint: 'push back' },
  { code: 'KeyE', label: 'SPEAK', hint: 'talk · wish' },
  { code: 'KeyL', label: 'LIGHT', hint: 'flashlight' },
]

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
  gap: 12px; pointer-events: none; z-index: 3; }
.touch-btn { width: 66px; height: 66px; border-radius: 50%; pointer-events: auto; touch-action: none;
  background: rgba(20,16,6,0.42); border: 2px solid rgba(201,186,114,0.5); color: #e8d9a0;
  font: bold 12px 'Courier New', monospace; letter-spacing: 1px; display: flex; align-items: center;
  justify-content: center; text-align: center; }
.touch-btn.act { width: 84px; height: 84px; font-size: 14px; border-color: rgba(201,186,114,0.8); }
.touch-btn.down { background: rgba(90,72,16,0.7); transform: scale(0.94); }
`

export function initTouchControls({ canvas, K, player, getPref } = {}) {
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
  for (const a of ACTIONS) {
    const b = document.createElement('div')
    b.className = 'touch-btn' + (a.code === 'KeyF' ? ' act' : '')
    b.textContent = a.label
    b.dataset.code = a.code
    b.title = a.hint
    actions.appendChild(b)
  }
  ui.append(look, stick, actions)
  document.body.appendChild(ui)

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

  // action buttons — set the key the loop consumes; visual press feedback
  for (const b of actions.children) {
    b.addEventListener('touchstart', (e) => {
      K[b.dataset.code] = true
      b.classList.add('down')
      e.preventDefault(); e.stopPropagation()
    }, { passive: false })
    const up = () => b.classList.remove('down')
    b.addEventListener('touchend', up)
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

  return { el: ui, destroy: () => { ui.remove(); style.remove() } }
}
