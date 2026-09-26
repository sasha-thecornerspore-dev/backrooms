// Fixer JC: the level-change fade (H-CORE-2) and the head of the game loop (H-CORE-3), both pure exports of game.js.
//  - createFader: the transition (frozen movement / events / contact damage) ends only AFTER the veil lifts, and an older fade's pending reveal
//    can never lift the veil in the middle of a newer (death) fade, nor end the newer transition.
//  - frameDue: a layout (which clears #c) only ever happens on a frame that is then drawn, so no callback presents a cleared canvas, whatever
//    fpsCap is and however often the window is resized (photosensitivity: no scene / blank strobe).
import { describe, it, expect } from 'vitest'
import { createFader, frameDue, createResizeGate, SETTLE_FRAMES, SETTLE_MAX_MS, FADE_OUT_MS, FADE_GRACE_MS } from '../src/renderer/game.js'
import { createFramePacer } from '../src/renderer/gfx-quality.js'

// a fake clock: timeouts fire as time advances; raf callbacks run when a frame is drawn
function sim() {
  let t = 0, frames = 0, seq = 0
  let timers = [], rafs = []
  const el = { style: { opacity: '0', transition: '' } }
  const S = {
    el, get t() { return t }, get frames() { return frames },
    deps: {
      el, frames: () => frames, now: () => t,
      setTimeout: (f, ms) => { timers.push({ at: t + ms, f, id: seq++ }) },
      raf: (f) => { rafs.push(f) },
    },
    // advance time by ms, drawing a frame every frameMs (0: no frames)
    run(ms, frameMs = 0, onFrame) {
      const end = t + ms
      let nextFrame = frameMs > 0 ? t + frameMs : Infinity
      for (;;) {
        const nt = timers.length ? Math.min(...timers.map((x) => x.at)) : Infinity
        const next = Math.min(nt, nextFrame)
        if (next > end) { t = end; return }
        t = next
        if (nt <= nextFrame) {
          const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at || a.id - b.id)
          timers = timers.filter((x) => x.at > t)
          for (const x of due) x.f()
        } else {
          frames++
          const q = rafs; rafs = []
          for (const f of q) f()
          if (onFrame) onFrame()
          nextFrame += frameMs
        }
      }
    },
  }
  return S
}

describe('the level fade: transition held while black, fades sequenced (H-CORE-2)', () => {
  it('the veil goes black, cb runs under it, the veil lifts only after SETTLE_FRAMES new frames, and the transition ends a grace AFTER that', () => {
    const s = sim(), f = createFader(s.deps)
    let built = -1, shownAt = -1, black = []
    f.run(() => { built = s.t }, () => { shownAt = s.t })
    expect(s.el.style.opacity).toBe('1')
    s.run(FADE_OUT_MS - 1, 0); expect(built).toBe(-1)
    s.run(1, 0); expect(built).toBe(FADE_OUT_MS)
    // slow first frames (a GPU start): 200 ms each
    s.run(3000, 200, () => black.push(s.el.style.opacity))
    const liftFrame = black.indexOf('0') + 1
    expect(liftFrame).toBe(SETTLE_FRAMES)                                  // lifted on the 5th frame of the new level, not before
    const liftT = FADE_OUT_MS + SETTLE_FRAMES * 200
    expect(shownAt).toBe(liftT + FADE_GRACE_MS)                            // never while the screen was black (the old code: FADE_OUT_MS + 150)
  })
  it('no frames at all: SETTLE_MAX_MS still lifts it (and ends the transition)', () => {
    const s = sim(), f = createFader(s.deps)
    let shown = 0
    f.run(() => {}, () => { shown++ })
    s.run(FADE_OUT_MS + SETTLE_MAX_MS - 1, 0)
    expect(s.el.style.opacity).toBe('1'); expect(shown).toBe(0)
    // the reveal is polled on rAF: one frame after the deadline lifts it
    s.run(50, 50)
    expect(s.el.style.opacity).toBe('0')
    s.run(FADE_GRACE_MS, 0); expect(shown).toBe(1)
  })
  it('THE RACE: a death fade that starts while an older fade still waits for its frames — the older reveal does not lift the veil, and the respawn is never seen', () => {
    const s = sim(), f = createFader(s.deps)
    const log = []
    f.run(() => log.push(['new level', s.t]), () => log.push(['A shown', s.t]))
    s.run(FADE_OUT_MS, 0)
    s.run(3 * 60, 60)                                                      // 3 frames of the new level: A's reveal is still waiting
    expect(s.el.style.opacity).toBe('1')
    let respawnT = -1
    f.run(() => { respawnT = s.t; log.push(['respawn', s.t]) }, () => log.push(['B shown', s.t]))           // die() on a live frame
    // run on at 60 ms frames and record the veil every frame
    const seen = []
    s.run(4000, 60, () => seen.push([s.t, s.el.style.opacity]))
    // the veil stays black from B's start until well after the respawn teleport: never lifted by A's reveal in between
    const firstLift = seen.find(([, o]) => o === '0')
    expect(respawnT).toBeGreaterThan(0)
    expect(seen.filter(([ts]) => ts > respawnT && ts <= firstLift[0]).length).toBe(SETTLE_FRAMES)   // lifted on the 5th frame AFTER the respawn
    expect(log.map((x) => x[0])).toEqual(['new level', 'respawn', 'B shown'])   // A's onShown never ran: it cannot end B's transition
  })
  it('a newer fade that starts during the older one\'s grace: the older onShown is dropped, the newer one ends the transition', () => {
    const s = sim(), f = createFader(s.deps)
    const log = []
    f.run(() => {}, () => log.push('A'))
    s.run(FADE_OUT_MS, 0); s.run(SETTLE_FRAMES * 20, 20)
    expect(s.el.style.opacity).toBe('0')
    f.run(() => {}, () => log.push('B'))                                    // inside A's 150 ms grace
    expect(s.el.style.opacity).toBe('1')
    s.run(5000, 20)
    expect(log).toEqual(['B']); expect(s.el.style.opacity).toBe('0')
  })
  it('a newer fade started during the older one\'s fade-OUT: the older cb still runs (it is the state change), but only the newer reveals', () => {
    const s = sim(), f = createFader(s.deps)
    const log = []
    f.run(() => log.push('A cb'), () => log.push('A shown'))
    s.run(200, 0)
    f.run(() => log.push('B cb'), () => log.push('B shown'))
    s.run(5000, 30)
    expect(log).toEqual(['A cb', 'B cb', 'B shown'])
    expect(f.gen).toBe(2)
  })
  it('without a #fade element: cb at once, the transition ends after the grace', () => {
    const s = sim(), f = createFader({ ...s.deps, el: null })
    const log = []
    f.run(() => log.push(['cb', s.t]), () => log.push(['shown', s.t]))
    expect(log).toEqual([['cb', 0]])
    s.run(FADE_GRACE_MS, 0)
    expect(log).toEqual([['cb', 0], ['shown', FADE_GRACE_MS]])
  })
})

describe('the loop head: fpsCap first, then the pending layout (H-CORE-3)', () => {
  // one animation-frame callback as game.js runs it: a layout clears #c; a frame that draws paints it again; what the compositor then shows
  function drive(fpsCap, hz, seconds, resizeEveryFrame) {
    const pacer = createFramePacer(), gate = createResizeGate()
    let cleared = false, presentedCleared = 0, draws = 0, layouts = 0
    const relayout = () => { layouts++; cleared = true }
    const n = Math.round(seconds * hz)
    for (let i = 1; i <= n; i++) {
      const ts = (i * 1000) / hz
      if (resizeEveryFrame) gate.request()                                  // a window drag: a resize event every frame
      if (frameDue(ts, pacer, fpsCap, gate, relayout)) { draws++; cleared = false }
      if (cleared) presentedCleared++
    }
    return { presentedCleared, draws, layouts, pending: gate.pending }
  }
  for (const [cap, hz] of [[30, 60], [60, 144], [60, 120], [30, 144], [0, 60]]) {
    it(`fpsCap ${cap || 'off'} on a ${hz} Hz display, resized every frame: never a cleared frame on screen; every drawn frame lays out`, () => {
      const r = drive(cap, hz, 2, true)
      expect(r.presentedCleared).toBe(0)
      expect(r.draws).toBeGreaterThan(0)
      expect(r.layouts).toBe(r.draws)                                        // the drag is still followed: one layout per DRAWN frame
    })
  }
  it('the old order (layout, then the pacer) did strobe: the model catches it', () => {
    const pacer = createFramePacer(), gate = createResizeGate()
    let cleared = false, presentedCleared = 0
    for (let i = 1; i <= 120; i++) {
      gate.request()
      if (gate.take()) cleared = true
      if (pacer.due((i * 1000) / 60, 30)) cleared = false
      if (cleared) presentedCleared++
    }
    expect(presentedCleared).toBeGreaterThan(30)                             // every other frame blank at fpsCap 30 / 60 Hz
  })
  it('a resize requested on a skipped frame is kept for the next drawn frame, not lost', () => {
    const pacer = createFramePacer(), gate = createResizeGate()
    let layouts = 0
    const due = []
    for (let i = 1; i <= 8; i++) {
      if (i === 2) gate.request()
      due.push(frameDue((i * 1000) / 60, pacer, 30, gate, () => { layouts++ }))
    }
    expect(layouts).toBe(1)
    const firstDrawAfter = due.findIndex((d, i) => i >= 1 && d)
    expect(firstDrawAfter).toBeGreaterThanOrEqual(1)
  })
})
