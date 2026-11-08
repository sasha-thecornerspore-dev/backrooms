// Vertical look, wired (look.js is the state, gfx-frame.js the y-shear): the mouse's movementY and the look-drag's vertical part are gathered
// on the player (player.pitchIn) and the loop's lookStep spends them once a frame, under the two prefs; lying down and under a fall's or a
// death's veil the view eases level, and every arrival and wake sets you down level. The pitch stays off the wire, out of the save and out
// of the map: the position heartbeat, the ward's payload and the snapshot carry exactly what they carried. The two prefs persist like
// every other (prefs.js).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { initTouchControls } from '../src/renderer/touch.js'
import { TOUCH_PITCH, lookStep } from '../src/renderer/look.js'
import { PREF_DEFAULTS, normalizePref, getPref, setPref } from '../src/renderer/prefs.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const game = read('../src/renderer/game.js'), touch = read('../src/renderer/touch.js')

describe('game.js', () => {
  it('the player carries the pitch beside the angle, from the start', () => {
    expect(game).toContain("import { lookInput, lookStep, lookLevel, MOUSE_PITCH } from './look.js'")
    expect(game).toMatch(/angle: 0, bob: 0, bobOffset: 0, moving: false,\n\s*pitch: 0, pitchIn: 0, /)
  })
  it('the mouse: movementY is gathered while the pointer is locked, at the yaw\'s rate and the same sensitivity', () => {
    expect(game).toContain("if (locked) player.angle += e.movementX * 0.002 * (getPref('mouseSensitivity') / 100)\n    if (locked) lookInput(player, e.movementY, MOUSE_PITCH, getPref('mouseSensitivity'))")
  })
  it('the loop spends it once a frame, before the render, under the two prefs; lying down and a fade hold it', () => {
    const at = (s) => { const i = game.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const step = "lookStep(player, dt, getPref('verticalLook'), getPref('invertVerticalLook'), transitioning || down.st === 'down')"
    expect(game.split(step).length).toBe(2)
    expect(at(step)).toBeGreaterThan(at('function loop(ts) {'))
    expect(at(step)).toBeLessThan(at('level.gfx.render(player, wallFn, flicker, allEntities, fogMul,'))
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
  it('source: the same gathering as the mouse, from the drag\'s last y', () => {
    expect(touch).toContain("import { lookInput, TOUCH_PITCH } from './look.js'")
    expect(touch).toContain('lookInput(player, t.clientY - lookY, TOUCH_PITCH, s); lookY = t.clientY')
  })
})

describe('the prefs', () => {
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
})
