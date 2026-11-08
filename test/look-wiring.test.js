// Vertical look, wired (look.js is the state, gfx-frame.js the y-shear): the mouse's movementY and the look-drag's vertical part are gathered
// on the player (player.pitchIn) and the loop's lookStep spends them once a frame, under the two prefs; lying down, under a fall's or a
// death's veil and while the arrow keys turn you (the mouse loose) the view eases level, and every arrival and wake sets you down level.
// Only the part of a look-drag that is mostly up and down tilts (touch.js tiltWeight): a turning swipe's drift does not. The pitch stays off the wire, out of the save and out
// of the map: the position heartbeat, the ward's payload and the snapshot carry exactly what they carried. The settings panel has the two
// rows, persisted like every other pref (prefs.js).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { initTouchControls, tiltWeight, lookYaw } from '../src/renderer/touch.js'
import { TOUCH_PITCH, lookStep } from '../src/renderer/look.js'
import { PREF_DEFAULTS, normalizePref, getPref, setPref } from '../src/renderer/prefs.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const game = read('../src/renderer/game.js'), html = read('../src/renderer/index.html'), touch = read('../src/renderer/touch.js')

describe('game.js', () => {
  it('the player carries the pitch beside the angle, from the start', () => {
    expect(game).toContain("import { lookMouse, lookStep, lookLevel } from './look.js'")
    expect(game).toMatch(/angle: 0, bob: 0, bobOffset: 0, moving: false,\n\s*pitch: 0, pitchIn: 0, /)
  })
  it('the mouse: the handler is look.js lookMouse (replayed there with event shapes), handed the lock and the sensitivity', () => {
    expect(game).toContain("document.addEventListener('mousemove', e => lookMouse(player, e, locked, getPref('mouseSensitivity')))")
    expect(game.split("addEventListener('mousemove'").length).toBe(2)
    expect(game).not.toContain('e.movementX'); expect(game).not.toContain('e.movementY')
  })
  it('the loop spends it once a frame, before the render, under the two prefs; lying down, a fade and an arrow-key turn hold it', () => {
    const at = (s) => { const i = game.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const step = "lookStep(player, dt, getPref('verticalLook'), getPref('invertVerticalLook'), transitioning || down.st === 'down' || (keyTurn && !touchUi))"
    expect(game.split(step).length).toBe(2)
    expect(at(step)).toBeGreaterThan(at('function loop(ts) {'))
    expect(at(step)).toBeLessThan(at('level.gfx.render(player, wallFn, flicker, allEntities, fogMul,'))
  })
  it('turning by the arrow keys (the mouse loose) brings the view back level: no key tilts it, and the one that turns you levels it', () => {
    const at = (s) => { const i = game.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const turn = "keyTurn = !locked && !!(K['ArrowLeft'] || K['ArrowRight'])"
    expect(game.split(turn).length).toBe(2)
    // set where the arrows turn you (inside the walking block: not lying down, not in the chat or a page), after the turn, before the step
    expect(at(turn)).toBeGreaterThan(at("if (!locked && K['ArrowRight']) player.angle += 0.04 * dt * 60"))
    expect(at(turn)).toBeGreaterThan(at("if (!transitioning && !chatOpen && !noteOpen && down.st !== 'down' && !kneel.st) {"))
    expect(at(turn)).toBeLessThan(at('player.moving = moved'))
    expect(at('let keyTurn = false')).toBeLessThan(at(turn))
    // and the hold is lookStep's own ease: a tilt left from before the mouse was let go comes back to exactly level
    const p = { pitch: 0.24, pitchIn: 0 }
    for (let i = 0; i < 240; i++) lookStep(p, 1 / 60, true, false, true)
    expect(p.pitch).toBe(0)
  })
  it('a travel and a death set you down level, under the veil', () => {
    expect(game).toMatch(/player\.x = a\.x; player\.y = a\.y\n\s*lookLevel\(player\)/)
    expect(game).toMatch(/else \{ const m = findOpenNear\(mid\.x, mid\.y, level\.grid\.floor\) \?\? mid; player\.x = m\.x; player\.y = m\.y \}\n\s*lookLevel\(player\)/)
    expect(game.match(/lookLevel\(player\)/g).length).toBe(2)
  })
  it('nothing new on the wire, in the save or on the map: the pitch is the renderer\'s alone', () => {
    expect(game).toContain('mpClient.sendPos(player.x, player.y, player.angle, player.hp)')
    expect(game).toContain('wardOut.x = player.x; wardOut.y = player.y; wardOut.a = +player.angle.toFixed(2); wardOut.lvl = level.index')
    expect(game).toMatch(/x: player\.x, y: player\.y, angle: player\.angle,\n\s*hp: player\.hp, maxHp: player\.maxHp,/)
    // game.js never reads the pitch itself (look.js writes it, the renderer reads it off the player it is handed), and nothing that
    // sends, saves, remembers or perceives does either
    expect(game).not.toMatch(/\.pitch\b/)
    for (const f of ['../src/net/client.js', '../src/net/evbus.js', '../src/renderer/save.js', '../src/renderer/levelmem.js',
      '../src/renderer/compose-perception.js', '../src/renderer/compose-polaroid.js', '../src/renderer/evidence.js', '../src/renderer/entities.js']) {
      expect(read(f), f).not.toMatch(/\.pitch\b|pitchIn|verticalLook/)
    }
    // the map card has a grid pitch of its own (the paper's cell spacing); it is handed the angle, never the view's pitch
    expect(game).toContain('mapCard.angleDirty(player.angle)')
  })
})

describe('touch.js: the look-drag tilts as well as turns', () => {
  const saved = {}
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k] } })
  function fakeDom() {
    const made = []
    const mk = (tag) => {
      const el = {
        tag, id: '', children: [], listeners: Object.create(null), dataset: {}, style: {}, className: '', textContent: '', title: '',
        classList: { add() {}, remove() {} },
        appendChild(c) { this.children.push(c); return c }, append(...cs) { for (const c of cs) this.children.push(c) },
        addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f) },
        getBoundingClientRect() { return { left: 0, top: 0, width: 132, height: 132 } },
        remove() {},
      }
      made.push(el); return el
    }
    return { made, document: { createElement: mk, getElementById: () => null, head: mk('head'), body: mk('body'), addEventListener() {} } }
  }
  it('replayed: a drag down the glass turns by its x and gathers its y on the player; the loop spends it (down looks down)', () => {
    for (const k of ['window', 'document']) saved[k] = globalThis[k]
    const win = { ontouchstart: null, listeners: Object.create(null), addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f) }, matchMedia: () => ({ matches: true }) }
    globalThis.window = win
    const { document, made } = fakeDom()
    globalThis.document = document
    const player = { angle: 0, pitch: 0, pitchIn: 0 }
    expect(initTouchControls({ canvas: {}, K: Object.create(null), player, getPref: () => 150 })).not.toBeNull()
    const look = made.find((el) => el.id === 'touch-look')
    const ev = (x, y) => ({ changedTouches: [{ identifier: 3, clientX: x, clientY: y }], preventDefault() {} })
    look.listeners.touchstart[0](ev(100, 200))
    win.listeners.touchmove[0](ev(110, 240))
    expect(player.angle).toBeCloseTo(10 * 0.0055 * 1.5, 12)
    expect(player.pitchIn).toBeCloseTo(40 * TOUCH_PITCH * 1.5, 12)
    expect(lookStep(player, 1 / 60, true, false, false)).toBeCloseTo(-40 * TOUCH_PITCH * 1.5, 12)
    win.listeners.touchmove[0](ev(110, 230))                    // back up a little: from the last y, not the first
    expect(player.pitchIn).toBeCloseTo(-10 * TOUCH_PITCH * 1.5, 12)
    win.listeners.touchend[0](ev(110, 230))
    win.listeners.touchmove[0](ev(300, 900))                    // that finger is gone: nothing more
    expect(player.pitchIn).toBeCloseTo(-10 * TOUCH_PITCH * 1.5, 12)
  })
  it("source: the same gathering as the mouse, from the drag's last y, weighed by how vertical the drag has been", () => {
    expect(touch).toContain("import { lookInput, TOUCH_PITCH } from './look.js'")
    expect(touch).toContain('lookInput(player, dy * tiltWeight(lookGX, lookGY), TOUCH_PITCH, s); lookY = t.clientY')
    expect(touch).toContain('lookId = t.identifier; lookX = t.clientX; lookY = t.clientY; lookGX = 0; lookGY = 0')
  })
  // a drag replayed through the real handler: n moves of `step` px, the i-th deg(i) degrees off the level (+ = down the glass)
  function replay(n, step, deg, sensPct = 100) {
    for (const k of ['window', 'document']) if (!(k in saved)) saved[k] = globalThis[k]      // (the real ones, not a previous replay's)
    const win = { ontouchstart: null, listeners: Object.create(null), addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f) }, matchMedia: () => ({ matches: true }) }
    globalThis.window = win
    const { document, made } = fakeDom()
    globalThis.document = document
    const player = { angle: 0, pitch: 0, pitchIn: 0 }
    initTouchControls({ canvas: {}, K: Object.create(null), player, getPref: () => sensPct })
    const look = made.find((el) => el.id === 'touch-look')
    const ev = (x, y) => ({ changedTouches: [{ identifier: 5, clientX: x, clientY: y }], preventDefault() {} })
    let x = 300, y = 300, tilt = 0
    look.listeners.touchstart[0](ev(x, y))
    for (let i = 0; i < n; i++) {
      const a = (deg(i) * Math.PI) / 180
      x += step * Math.cos(a); y += step * Math.sin(a)
      win.listeners.touchmove[0](ev(x, y))
      tilt = lookStep(player, 1 / 60, true, false, false)
    }
    win.listeners.touchend[0](ev(x, y))
    return { tilt, angle: player.angle }
  }
  it('a turning swipe does not tilt: 200 px drifting 15 degrees, or a thumb arc curving to 20, turns the full way and tilts under 0.03', () => {
    const straight = replay(20, 10, () => 15), arc = replay(20, 10, (i) => i, 150), up = replay(20, 10, () => -15)
    for (const r of [straight, arc, up]) expect(Math.abs(r.tilt)).toBeLessThan(0.03)
    expect(straight.angle).toBeCloseTo(lookYaw(200 * Math.cos(Math.PI / 12), 100), 9)   // the turn itself is untouched
  })
  it('a drag mostly up or down tilts at the full TOUCH_PITCH; a diagonal too', () => {
    expect(replay(10, 4, () => 90).tilt).toBeCloseTo(-40 * TOUCH_PITCH, 9)              // straight down the glass: looks down
    expect(replay(10, 4, () => -90).tilt).toBeCloseTo(40 * TOUCH_PITCH, 9)
    expect(replay(10, 4, () => 45).tilt).toBeCloseTo(-40 * Math.sin(Math.PI / 4) * TOUCH_PITCH, 9)
  })
  it('tiltWeight: 0 for a sideways drag, 1 for an up-and-down one, a ramp between', () => {
    expect(tiltWeight(0, 0)).toBe(0); expect(tiltWeight(100, 0)).toBe(0); expect(tiltWeight(100, 30)).toBe(0)
    expect(tiltWeight(100, 60)).toBe(1); expect(tiltWeight(0, 5)).toBe(1); expect(tiltWeight(100, 45)).toBeCloseTo(0.5, 6)
    for (let r = 0; r < 2; r += 0.01) { const w = tiltWeight(100, 100 * r); expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(1) }
  })
})

describe('the prefs and the settings panel', () => {
  it('vertical look starts on, the invert off; both are booleans whatever is stored', () => {
    expect(PREF_DEFAULTS.verticalLook).toBe(true)
    expect(PREF_DEFAULTS.invertVerticalLook).toBe(false)
    for (const bad of ['yes', 1, null, undefined, {}]) {
      expect(normalizePref('verticalLook', bad), String(bad)).toBe(true)
      expect(normalizePref('invertVerticalLook', bad), String(bad)).toBe(false)
    }
    expect(normalizePref('verticalLook', false)).toBe(false)
    expect(normalizePref('invertVerticalLook', true)).toBe(true)
  })
  it('set and read back live (the loop reads them every frame)', () => {
    const was = [getPref('verticalLook'), getPref('invertVerticalLook')]
    setPref('verticalLook', false); setPref('invertVerticalLook', true)
    expect(getPref('verticalLook')).toBe(false); expect(getPref('invertVerticalLook')).toBe(true)
    setPref('verticalLook', 'garbage')
    expect(getPref('verticalLook')).toBe(true)                  // an invalid value is the default
    setPref('verticalLook', was[0]); setPref('invertVerticalLook', was[1])
  })
  it('two rows under the mouse sensitivity, in the panel\'s own style, saved and loaded like the rest', () => {
    const sens = html.indexOf('id="set-sens"'), v = html.indexOf('id="set-vlook"'), inv = html.indexOf('id="set-vlook-invert"'), cre = html.indexOf('id="set-creatures"')
    expect(sens).toBeGreaterThan(-1); expect(v).toBeGreaterThan(sens); expect(inv).toBeGreaterThan(v); expect(cre).toBeGreaterThan(inv)
    expect(html).toContain('<label class="toggle-row"><span>Vertical look <span class="set-hint">look up and down too</span></span><input type="checkbox" id="set-vlook"/></label>')
    expect(html).toContain('<label class="toggle-row"><span>Invert vertical look <span class="set-hint">push up to look down</span></span><input type="checkbox" id="set-vlook-invert"/></label>')
    expect(html).toContain("prefChk('set-vlook', 'verticalLook'); prefChk('set-vlook-invert', 'invertVerticalLook')")
    expect(html).toContain("document.getElementById('set-vlook').checked      = p.verticalLook")
    expect(html).toContain("document.getElementById('set-vlook-invert').checked = p.invertVerticalLook")
    expect(html).toContain('syncVLook(p.verticalLook)')
    // the hints keep the house style: lowercase, no digits, no exclamation marks
    for (const h of ['look up and down too', 'push up to look down']) { expect(h).toBe(h.toLowerCase()); expect(h).not.toMatch(/[0-9!]/) }
  })
})
