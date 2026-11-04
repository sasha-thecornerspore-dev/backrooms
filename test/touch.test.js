import { describe, it, expect, afterEach } from 'vitest'
import { stickToKeys, lookYaw, ACTIONS, SITUATIONAL, TYPE_ALONE, beaconShown, lineShown, placeDiscs, LAYOUT, initTouchControls } from '../src/renderer/touch.js'
import { beaconDecision } from '../src/renderer/compose-gates.js'

const R = 66

describe('stickToKeys', () => {
  it('deadzone: a tiny nudge moves nothing', () => {
    expect(stickToKeys(3, -3, R)).toEqual({ KeyW: false, KeyS: false, KeyA: false, KeyD: false, ShiftLeft: false })
  })
  it('pushing up = forward (W), no accidental strafe', () => {
    const k = stickToKeys(0, -40, R)
    expect(k.KeyW).toBe(true)
    expect(k.KeyS).toBe(false); expect(k.KeyA).toBe(false); expect(k.KeyD).toBe(false)
  })
  it('down = back (S), left = A, right = D', () => {
    expect(stickToKeys(0, 40, R).KeyS).toBe(true)
    expect(stickToKeys(-40, 0, R).KeyA).toBe(true)
    expect(stickToKeys(40, 0, R).KeyD).toBe(true)
  })
  it('forward-right diagonal engages both W and D', () => {
    const k = stickToKeys(30, -30, R)
    expect(k.KeyW).toBe(true); expect(k.KeyD).toBe(true)
    expect(k.KeyS).toBe(false); expect(k.KeyA).toBe(false)
  })
  it('a rim-forward push sprints (ShiftLeft + W)', () => {
    const k = stickToKeys(0, -R, R)
    expect(k.KeyW).toBe(true); expect(k.ShiftLeft).toBe(true)
  })
  it('a mid-range forward push does NOT sprint', () => {
    const k = stickToKeys(0, -40, R)
    expect(k.KeyW).toBe(true); expect(k.ShiftLeft).toBe(false)
  })
})

describe('lookYaw', () => {
  it('is zero for no drag, positive rightward, negative leftward', () => {
    expect(lookYaw(0, 100)).toBe(0)
    expect(lookYaw(100, 100)).toBeGreaterThan(0)
    expect(lookYaw(-100, 100)).toBeLessThan(0)
  })
  it('scales linearly with the sensitivity pref', () => {
    expect(lookYaw(100, 200)).toBeCloseTo(lookYaw(100, 100) * 2, 6)
  })
})

// the map opens from Tab on a keyboard and from the paper corner #map-tab on a phone (sharedConventions #12): the action buttons stay the
// five they were plus the whistle (W5's CALL, last), and none of them is Tab — the tab's touchstart / click set K['Tab'] itself (game.js),
// so the one edge in the loop folds it
describe('ACTIONS', () => {
  it('has exactly six entries and none is Tab', () => {
    expect(ACTIONS).toHaveLength(6)
    expect(ACTIONS.map(a => a.code)).toEqual(['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC'])
    expect(ACTIONS.some(a => a.code === 'Tab')).toBe(false)
    expect(ACTIONS[5]).toEqual({ code: 'KeyC', label: 'CALL', hint: 'whistle' })
  })
})

// ── I5: TYPE (Enter) and BEACON (B), the two buttons that come and go ──────────────────────────────────────────────────────────────
// A phone had no way to press B or Enter, so the field console's cases, the chat and the counter-claim were out of its reach. Two more
// discs, in the six's style, each shown only while its key would do something (game.js tells touch.js once a frame, through show()).
// The discs are laid out from the bottom-right corner up, wrapping left, clear of every other control, so the smallest supported phone
// (360 css px wide: the settings box's own min-width) carries all eight either way up.
describe('SITUATIONAL', () => {
  it('is TYPE (Enter) then BEACON (B), after the six, which stay as they were', () => {
    expect(SITUATIONAL).toEqual([
      { code: 'Enter', label: 'TYPE', hint: 'chat · console' },
      { code: 'KeyB', label: 'BEACON', hint: 'send a signal' },
    ])
    expect(ACTIONS.map((a) => a.code)).toEqual(['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC'])
    for (const s of SITUATIONAL) {
      expect(ACTIONS.some((a) => a.code === s.code), s.code).toBe(false)
      expect(s.code).not.toBe('Tab')
    }
  })
  it('labels and hints are in the six\'s style: a short capital word; a lowercase hint with no digits, number words or "!"', () => {
    const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|first|second|third|half)\b/
    for (const s of [...ACTIONS, ...SITUATIONAL]) {
      expect(s.label, s.label).toMatch(/^[A-Z]{3,6}$/)
      expect(s.hint, s.label).toBe(s.hint.toLowerCase())
      expect(s.hint, s.label).not.toMatch(/[0-9!]/)
      expect(s.hint, s.label).not.toMatch(NUMBER_WORDS)
    }
  })
})

describe('beaconShown: BEACON only where B would push a beacon', () => {
  it('a beacon must be set (the effect is not off) and the verbs live', () => {
    for (const e of ['ntfy', 'discord', 'custom']) { expect(beaconShown(e, true), e).toBe(true); expect(beaconShown(e, false), e).toBe(false) }
    for (const e of ['off', '', null, undefined]) expect(beaconShown(e, true), String(e)).toBe(false)
  })
  it('agrees with compose-gates beaconDecision on every effect: shown exactly when B fires (the counter-claim rides the same push)', () => {
    const rules = { beacon: {} }
    for (const effect of ['off', 'ntfy', 'discord', 'custom', '', undefined]) {
      for (const target of ['', 'extension30150a']) {
        const b = beaconDecision({ effect, target, rules, status: 'notice', closing: null, anchor: null, webhook: target })
        expect(beaconShown(effect, true), `${effect} ${target}`).toBe(b.fire)
      }
    }
  })
})

describe('lineShown: TYPE only where Enter would open the line', () => {
  it('the line must be free (no card, wish box or line already up); in a room it is the chat', () => {
    expect(lineShown(true, true)).toBe(true)
    expect(lineShown(false, true)).toBe(false)
    expect(lineShown(false, false)).toBe(false)
  })
  it('alone it is the field console (TYPE_ALONE: the console answers solo); turned off, alone hides it and a room still shows it', () => {
    expect(TYPE_ALONE).toBe(true)
    expect(lineShown(true, false)).toBe(true)
    expect(lineShown(true, false, false)).toBe(false)
    expect(lineShown(true, true, false)).toBe(true)
  })
})

// ── the layout. The keep-out rects are the page's own controls as tools/gfx/page.cjs measured them in the real renderer (touch emulation,
//    a fresh solo run): the stick, the gear, the map's paper corner, the gauges' plate, the six item slots and ✕. A screen up to 700 px
//    wide docks the slots under the gauges — full width upright; on its side index.html caps the dock at 380 px, so the discs keep the
//    right-hand side — and a wider one (a landscape phone over 700 px, a tablet) docks them along the bottom ──
function hudRects(w, h) {
  const box = (x, y, r, b) => ({ x, y, r, b })
  const rects = [box(26, h - 158, 158, h - 26), box(w - 50, 12, w - 12, 50), box(11, 95, 49, 132)]   // the stick, the gear, the map corner
  if (w <= 700) {
    rects.push(box(12, 10, 230, 90))                                 // the plate (min-width 0 when narrow)
    const dock = w > h ? Math.min(w - 24, 380) : w - 24              // index.html: the landscape cap
    const sw = (dock - 30 - 4 - 5 * 3) / 6
    for (let i = 0; i < 6; i++) rects.push(box(12 + i * (sw + 3), 138, 12 + i * (sw + 3) + sw, 176))
    rects.push(box(12 + dock - 30, 138, 12 + dock, 176))             // ✕
  } else {
    rects.push(box(12, 10, 244, 90))
    const x0 = (w - 457) / 2, y0 = h - 48
    for (let i = 0; i < 6; i++) rects.push(box(x0 + i * 77, y0, x0 + i * 77 + 72, y0 + 32))
    rects.push(box(w / 2 + 240, y0, w / 2 + 346, y0 + 32))           // '✕ set down'
  }
  return rects
}
const SIX = [LAYOUT.act, 66, 66, 66, 66, 66]
const EIGHT = [...SIX, 66, 66]
const meets = (a, b, pad) => a.x < b.r + pad && a.r > b.x - pad && a.y < b.b + pad && a.b > b.y - pad
function laid(w, h, sizes, keep = hudRects(w, h)) {
  const out = []
  const n = placeDiscs(w, h, sizes, keep, out, Math.min(6, sizes.length))   // the six, then the two that come and go (as touch.js passes it)
  const discs = out.map((p, i) => (p ? { x: p.x, y: p.y, r: p.x + sizes[i], b: p.y + sizes[i] } : null))
  return { n, out, discs, keep }
}
function expectClear({ discs, keep }, w, h) {
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i]
    expect(d, `disc ${i}`).not.toBeNull()
    expect(d.x >= 0 && d.y >= 0 && d.r <= w && d.b <= h, `disc ${i} on screen`).toBe(true)
    for (let j = 0; j < i; j++) expect(meets(d, discs[j], LAYOUT.gap - 0.01), `disc ${i} vs disc ${j}`).toBe(false)
    for (const k of keep) expect(meets(d, k, LAYOUT.clear - 0.01), `disc ${i} vs ${JSON.stringify(k)}`).toBe(false)
  }
}

describe('placeDiscs: the smallest supported phone carries all eight, upright and on its side, clear of every other control', () => {
  for (const [w, h] of [[360, 640], [640, 360]]) {
    it(`${w}x${h}: the six, the six and either one, and all eight`, () => {
      for (const sizes of [SIX, [...SIX, 66], EIGHT]) {
        const L = laid(w, h, sizes)
        expect(L.n, `${sizes.length} discs`).toBe(sizes.length)
        expectClear(L, w, h)
      }
    })
    it(`${w}x${h}: ACT keeps its corner`, () => {
      expect(laid(w, h, EIGHT).out[0]).toEqual({ x: w - LAYOUT.right - LAYOUT.act, y: h - LAYOUT.bottom - LAYOUT.act })
    })
  }
  it('360x640: five up the right edge, under the slots; then CALL, TYPE and BEACON up a second column beside ACT, clear of the stick', () => {
    const { out } = laid(360, 640, EIGHT)
    expect(out.slice(1, 5).map((p) => p.x)).toEqual([274, 274, 274, 274])
    expect(out.slice(5).map((p) => p.x)).toEqual([178, 178, 178])
    expect(out.slice(5).map((p) => p.y)).toEqual([544, 466, 388])
  })
  it('640x360: three up the edge (the gear stops a fourth), three up the next column, TYPE and BEACON in a third, clear of the capped dock', () => {
    const { out } = laid(640, 360, EIGHT)
    expect(out.map((p) => p.x)).toEqual([536, 554, 554, 458, 458, 458, 380, 380])
    expect(out.slice(6).map((p) => p.y)).toEqual([264, 186])
  })
})

describe('placeDiscs: other screens', () => {
  for (const [w, h] of [[375, 667], [667, 375], [390, 844], [844, 390], [412, 915], [915, 412], [768, 1024], [1024, 768]]) {
    it(`${w}x${h}: all eight on screen, clear of each other and of every control`, () => {
      const L = laid(w, h, EIGHT)
      expect(L.n).toBe(8)
      expectClear(L, w, h)
    })
  }
  it('a tall phone with nothing in the way keeps the old stack for the six (one column, ACT in the corner, a disc every 78 px); TYPE and BEACON stand beside ACT', () => {
    const { out } = laid(390, 844, EIGHT)
    expect(out.map((p) => p.x)).toEqual([286, 304, 304, 304, 304, 304, 208, 208])
    expect(out.map((p) => p.y)).toEqual([730, 652, 574, 496, 418, 340, 748, 670])
  })
  it('the two that come and go take a column of their own when its foot is free, and never climb over the middle of an upright phone', () => {
    for (const [w, h] of [[390, 844], [412, 915], [640, 360], [844, 390], [768, 1024], [1024, 768]]) {
      const { out } = laid(w, h, EIGHT)
      expect(out[6].x, `${w}x${h}`).toBeLessThan(Math.min(...out.slice(0, 6).map((p) => p.x)))
      expect(out[6].x, `${w}x${h}`).toBe(out[7].x)
      expect(out[6].y + 66, `${w}x${h}`).toBeGreaterThan(h - 30 - LAYOUT.lift - 1)
    }
    // where the stick takes that foot (a small phone upright) they carry on up the stack's last column instead
    const small = laid(360, 640, EIGHT).out
    expect([small[6].x, small[7].x]).toEqual([small[5].x, small[5].x])
  })
  it('a column lifts over a dock along the bottom, but never over the stick', () => {
    const out = []
    placeDiscs(400, 400, [66, 66, 66], [{ x: 0, y: 300, r: 400, b: 400 }], out)
    expect(out).toEqual([null, null, null])                         // a tall block along the bottom: no column can start
    placeDiscs(400, 400, [66], [{ x: 0, y: 352, r: 400, b: 384 }], out)
    expect(out[0]).toEqual({ x: 314, y: 352 - LAYOUT.clear - 66 })
  })
  it('a dock along the bottom: a column starts just above it instead of under it', () => {
    const { out, keep } = laid(844, 390, EIGHT)
    const x = keep[keep.length - 1]                                   // ✕ set down
    expect(out[0].y + LAYOUT.act).toBe(x.y - LAYOUT.clear)
  })
  it('showing a later disc never moves an earlier one', () => {
    for (const [w, h] of [[360, 640], [640, 360], [844, 390], [390, 844]]) {
      const six = laid(w, h, SIX).out, seven = laid(w, h, [...SIX, 66]).out, eight = laid(w, h, EIGHT).out
      expect(seven.slice(0, 6), `${w}x${h}`).toEqual(six)
      expect(eight.slice(0, 7), `${w}x${h}`).toEqual(seven)
    }
  })
  it('no room left: the rest come back null, and the count says how many were placed', () => {
    const out = []
    expect(placeDiscs(150, 150, EIGHT, [], out)).toBeLessThan(8)
    expect(out.length).toBe(8)
    expect(out.some((p) => p === null)).toBe(true)
    expect(placeDiscs(0, 0, [66], [], out)).toBe(0)
  })
})

// ── the DOM adapter, on a fake page: the two discs start hidden, show(line, beacon) brings each out, TYPE runs the game's own Enter inside
//    the finger's lift (so the focus lands inside the gesture and the phone's keyboard comes up), BEACON sets K.KeyB for the loop ──
describe('initTouchControls: TYPE and BEACON on a fake page', () => {
  const saved = {}
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k] } })
  function rig({ taps, w = 360, h = 640 } = {}) {
    for (const k of ['window', 'document']) saved[k] = globalThis[k]
    const made = [], winL = Object.create(null), keep = hudRects(w, h)
    let queries = 0
    const mk = (tag) => {
      const cls = new Set()
      const el = {
        tag, children: [], listeners: Object.create(null), dataset: {}, style: {}, title: '', textContent: '',
        get className() { return [...cls].join(' ') }, set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c) },
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
        appendChild(c) { this.children.push(c); return c }, append(...cs) { for (const c of cs) this.children.push(c) },
        addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f) },
        removeEventListener() {},
        getBoundingClientRect() { const s = keep[0]; return { left: s.x, top: s.y, right: s.r, bottom: s.b, width: s.r - s.x, height: s.b - s.y } },   // the stick
        remove() {},
      }
      made.push(el); return el
    }
    const keepEls = keep.slice(1).map((r) => ({ getBoundingClientRect: () => ({ left: r.x, top: r.y, right: r.r, bottom: r.b, width: r.r - r.x, height: r.b - r.y }) }))
    globalThis.window = { ontouchstart: null, innerWidth: w, innerHeight: h, addEventListener(t, f) { (winL[t] || (winL[t] = [])).push(f) }, removeEventListener() {}, matchMedia: () => ({ matches: true }) }
    globalThis.document = { createElement: mk, getElementById: () => null, head: mk('head'), body: mk('body'), addEventListener() {}, querySelectorAll: () => { queries++; return keepEls } }
    const K = Object.create(null), edges = { Space: { press: 0, release: 0 } }
    const ui = initTouchControls({ canvas: {}, K, player: { angle: 0 }, getPref: () => 100, edges, taps })
    const btn = (code) => made.find((el) => el.dataset.code === code)
    return { ui, K, btn, winL, queries: () => queries }
  }
  const ev = { type: 'touchstart', preventDefault() {}, stopPropagation() {} }
  const off = (b) => b.classList.contains('off')

  it('mounts eight discs; TYPE and BEACON start hidden; show(line, beacon) brings out exactly the ones asked for', () => {
    const { ui, btn } = rig()
    const type = btn('Enter'), beacon = btn('KeyB')
    expect([type.textContent, type.title, beacon.textContent, beacon.title]).toEqual(['TYPE', 'chat · console', 'BEACON', 'send a signal'])
    expect([off(type), off(beacon)]).toEqual([true, true])
    for (const c of ['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC']) expect(off(btn(c)), c).toBe(false)
    ui.show(true, false); expect([off(type), off(beacon)]).toEqual([false, true])
    ui.show(false, true); expect([off(type), off(beacon)]).toEqual([true, false])
    ui.show(true, true); expect([off(type), off(beacon)]).toEqual([false, false])
    ui.show(false, false); expect([off(type), off(beacon)]).toEqual([true, true])
  })
  it('BEACON is a plain key button: touchstart sets K.KeyB for the loop to edge-consume, like the six', () => {
    const { ui, K, btn } = rig()
    ui.show(false, true)
    const b = btn('KeyB')
    b.listeners.touchstart[0](ev); for (const f of b.listeners.touchend) f({ type: 'touchend' })
    expect(K.KeyB).toBe(true)
  })
  it('a BEACON press still waiting when the disc goes away is let go (no push lands later, when the verbs come back)', () => {
    const { ui, K, btn } = rig()
    ui.show(false, true)
    btn('KeyB').listeners.touchstart[0](ev)
    ui.show(false, false)
    expect(K.KeyB).toBe(false)
  })
  it('TYPE with the game\'s Enter: nothing on touchstart, the Enter on the lift (touchend), never on a cancel; K.Enter is never set', () => {
    let opened = 0
    const { ui, K, btn } = rig({ taps: { Enter: () => { opened++ } } })
    ui.show(true, false)
    const t = btn('Enter')
    t.listeners.touchstart[0](ev)
    expect(opened).toBe(0)
    for (const f of t.listeners.touchend) f({ type: 'touchend' })
    expect(opened).toBe(1)
    t.listeners.touchstart[0](ev); for (const f of t.listeners.touchcancel) f({ type: 'touchcancel' })
    expect(opened).toBe(1)
    expect(K.Enter).toBeUndefined()
  })
  it('TYPE without a tap given falls back to a plain key: K.Enter, for the loop\'s Enter branch', () => {
    const { ui, K, btn } = rig()
    ui.show(true, false)
    btn('Enter').listeners.touchstart[0](ev)
    expect(K.Enter).toBe(true)
  })
  it('places the shown discs with placeDiscs over the page\'s own controls, and measures again only when the set or the screen changes', () => {
    const { ui, btn, queries, winL } = rig()
    const codes = ['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC', 'Enter', 'KeyB']
    ui.show(true, true)
    const want = []
    placeDiscs(360, 640, EIGHT, hudRects(360, 640), want, 6)
    for (let i = 0; i < 8; i++) expect([btn(codes[i]).style.left, btn(codes[i]).style.top], codes[i]).toEqual([want[i].x + 'px', want[i].y + 'px'])
    const q = queries()
    for (let i = 0; i < 10; i++) ui.show(true, true)                // the same set, frame after frame: nothing is measured again
    expect(queries()).toBe(q)
    for (const f of winL.resize || []) f()
    expect(queries()).toBe(q + 1)
  })
})
