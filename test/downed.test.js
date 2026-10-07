// downed.js (W5): going down instead of dying when a friend is on the floor, being counted back by a kneeling friend, and the
// kneeler's side. All on an injected millisecond clock (game.js hands them performance.now()).
import { describe, it, expect } from 'vitest'
import {
  createDownState, downedInFront, createKneel,
  DOWN_LINE, KNEEL_HINT, HANDS_LINE, LIGHT_STAYS_LINE, WOKEN_LINE, KNEELER_LINE, WAKE, KNEELER_SANITY, DOWN_BEAT,
} from '../src/renderer/downed.js'

const down0 = () => { const d = createDownState({ now: () => 0 }); d.goDown(0); return d }

describe('createDownState: being counted back', () => {
  it('goDown at 0; 8 ticks at 500 ms from one id, the first at 0.5 s: the first 7 are progress, the 8th (4.0 s) wakes', () => {
    const d = down0()
    expect(d.st).toBe('down'); expect(d.since).toBe(0); expect(d.progress).toBe(0); expect(d.kneeler).toBe(null)
    for (let i = 1; i <= 7; i++) expect(d.kneelTick('ash', i * 500)).toBe('progress')
    expect(d.progress).toBe(7); expect(d.kneeler).toBe('ash')
    expect(d.kneelTick('ash', 4000)).toBe('woken')
    expect(d.st).toBe('ok'); expect(d.progress).toBe(0); expect(d.kneeler).toBe(null); expect(d.since).toBeNaN()
  })
  it('with the first tick at 0 the 8th (3.5 s) is progress and the 9th (4.0 s) wakes: the fall takes 4 s to be a fall', () => {
    const d = down0()
    for (let i = 0; i < 8; i++) expect(d.kneelTick('ash', i * 500)).toBe('progress')
    expect(d.progress).toBe(8)
    expect(d.kneelTick('ash', 4000)).toBe('woken')
  })
  it('ticks 200 ms apart count once per 350 ms; the ignored tick does not refresh the clock', () => {
    const d = down0()
    expect(d.kneelTick('ash', 0)).toBe('progress')
    expect(d.kneelTick('ash', 200)).toBe('ignored')
    expect(d.kneelTick('ash', 400)).toBe('progress')
    expect(d.kneelTick('ash', 600)).toBe('ignored')
    expect(d.kneelTick('ash', 800)).toBe('progress')
    expect(d.progress).toBe(3)
  })
  it('8 ticks 350 ms apart reach progress 8 at 2.45 s but do not wake before 4 s; kept up, the tick at 4.0 s wakes', () => {
    const d = down0()
    for (let i = 0; i < 8; i++) expect(d.kneelTick('ash', i * 350)).toBe('progress')
    expect(d.progress).toBe(8)
    expect(d.kneelTick('ash', 2950)).toBe('progress')
    expect(d.kneelTick('ash', 3500)).toBe('progress')
    expect(d.kneelTick('ash', 4000)).toBe('woken')
  })
  it('lift descends 0.9 -> 0.45 as progress goes 0 -> 8 and reads 0 when ok', () => {
    const d = down0()
    expect(d.lift()).toBeCloseTo(0.9, 12)
    for (let i = 0; i < 4; i++) d.kneelTick('ash', i * 500)
    expect(d.lift()).toBeCloseTo(0.675, 12)
    for (let i = 4; i < 8; i++) d.kneelTick('ash', i * 500)
    expect(d.lift()).toBeCloseTo(0.45, 12)
    d.kneelTick('ash', 4000)
    expect(d.lift()).toBe(0)
    expect(createDownState({ now: () => 0 }).lift()).toBe(0)
  })
  it("a second id is ignored during the first's 1.2 s lock and takes over after 1.3 s of silence, progress restarted at 1", () => {
    const d = down0()
    d.kneelTick('ash', 0); d.kneelTick('ash', 500)
    expect(d.kneelTick('moss', 600)).toBe('ignored')
    expect(d.kneelTick('moss', 1700)).toBe('ignored')          // 1.2 s since ash's last: still held
    expect(d.kneeler).toBe('ash'); expect(d.progress).toBe(2)
    expect(d.kneelTick('moss', 1800)).toBe('progress')
    expect(d.kneeler).toBe('moss'); expect(d.progress).toBe(1)
    expect(d.kneelTick('ash', 2000)).toBe('ignored')
  })
  it('after 1.3 s of silence from the SAME id the count restarts too (the veil darkens back)', () => {
    const d = down0()
    for (let i = 0; i < 5; i++) d.kneelTick('ash', i * 500)
    expect(d.progress).toBe(5)
    expect(d.kneelTick('ash', 2000 + 1300)).toBe('progress')
    expect(d.progress).toBe(1)
    expect(d.lift()).toBeCloseTo(0.9 - 0.45 / 8, 12)
  })
  it("tick reports 'timeout' once at 25 s; st stays down until reset()", () => {
    const d = down0()
    expect(d.tick(24900)).toBe(null)
    expect(d.tick(25100)).toBe('timeout')
    expect(d.tick(25200)).toBe(null)
    expect(d.tick(40000)).toBe(null)
    expect(d.st).toBe('down')
    d.reset()
    expect(d.st).toBe('ok'); expect(d.since).toBeNaN(); expect(d.progress).toBe(0); expect(d.kneeler).toBe(null)
    expect(d.tick(90000)).toBe(null)
    d.goDown(100000)
    expect(d.tick(125000)).toBe('timeout')                       // a new fall times out afresh
  })
  it("kneelTick after 'woken' or on ok is ignored; wakeNow wakes at once (no hold) while down, ignored when ok", () => {
    const d = down0()
    for (let i = 1; i <= 8; i++) d.kneelTick('ash', i * 500)
    expect(d.kneelTick('ash', 4500)).toBe('ignored')
    expect(d.wakeNow(4600)).toBe('ignored')
    const e = down0()
    expect(e.wakeNow(100)).toBe('woken')
    expect(e.st).toBe('ok'); expect(e.lift()).toBe(0)
    expect(e.kneelTick('ash', 200)).toBe('ignored')
  })
  it('goDown while down is a no-op (downAt unchanged)', () => {
    const d = down0()
    d.kneelTick('ash', 0)
    d.goDown(3000)
    expect(d.since).toBe(0); expect(d.progress).toBe(1)
    expect(d.tick(25000)).toBe('timeout')
  })
  it('every method defaults its clock to now()', () => {
    let t = 1000
    const d = createDownState({ now: () => t })
    d.goDown(); expect(d.since).toBe(1000)
    t = 26000; expect(d.tick()).toBe('timeout')
    d.reset(); t = 30000; d.goDown()
    for (let i = 0; i < 8; i++) { t += 500; d.kneelTick('ash') }
    expect(d.st).toBe('ok')
  })
  it('takes its numbers as options', () => {
    const d = createDownState({ now: () => 0, limitMs: 1000, holdMs: 0, ticksToWake: 2, minTickMs: 100, lockMs: 300 })
    d.goDown(0)
    expect(d.kneelTick('a', 0)).toBe('progress')
    expect(d.kneelTick('a', 100)).toBe('woken')
    d.reset(); d.goDown(0)
    expect(d.tick(1000)).toBe('timeout')
  })
})

describe('downedInFront', () => {
  const player = { x: 10, y: 10, angle: 0 }
  const rec = (id, dx, dy, st = 'down') => ({ id, name: id, x: 10 + dx, y: 10 + dy, st })
  it('picks a downed friend 1.2 cells dead ahead; 0.7 rad off or 1.4 cells away is nothing', () => {
    const r = rec('a', 1.2, 0)
    expect(downedInFront(player, [r])).toBe(r)                   // the record itself: no allocation
    expect(downedInFront(player, [rec('b', 1.2 * Math.cos(0.7), 1.2 * Math.sin(0.7))])).toBe(null)
    expect(downedInFront(player, [rec('c', 1.2 * Math.cos(0.55), -1.2 * Math.sin(0.55))]).id).toBe('c')
    expect(downedInFront(player, [rec('d', 1.4, 0)])).toBe(null)
    expect(downedInFront(player, [])).toBe(null)
  })
  it("only st 'down' counts", () => {
    expect(downedInFront(player, [rec('a', 1, 0, 'ok'), rec('b', 1, 0, 'kneel'), rec('c', 1, 0, null)])).toBe(null)
  })
  it('two candidates: the nearer', () => {
    const far = rec('far', 1.25, 0), near = rec('near', 0.8, 0.1)
    expect(downedInFront(player, [far, near])).toBe(near)
    expect(downedInFront(player, [near, far])).toBe(near)
  })
  it('wraps the heading (a friend behind the seam of ±π is still in front)', () => {
    const p = { x: 0, y: 0, angle: Math.PI - 0.1 }
    const r = { id: 'a', x: Math.cos(-Math.PI + 0.2), y: Math.sin(-Math.PI + 0.2), st: 'down' }
    expect(downedInFront(p, [r])).toBe(r)
    expect(downedInFront({ x: 0, y: 0, angle: 2 * Math.PI }, [{ id: 'b', x: 1, y: 0, st: 'down' }]).id).toBe('b')
  })
  it('an injected line of sight that says no is nothing; one that says yes passes the coordinates', () => {
    const r = rec('a', 1, 0)
    expect(downedInFront(player, [r], { los: () => false })).toBe(null)
    const seen = []
    expect(downedInFront(player, [r], { los: (ax, ay, bx, by) => { seen.push([ax, ay, bx, by]); return true } })).toBe(r)
    expect(seen).toEqual([[10, 10, 11, 10]])
  })
  it('takes cells and arc as options', () => {
    expect(downedInFront(player, [rec('a', 2, 0)], { cells: 2.5 }).id).toBe('a')
    expect(downedInFront(player, [rec('a', 0, 1)], { arc: Math.PI })).not.toBe(null)
  })
})

describe('createKneel', () => {
  const player = { x: 0, y: 0 }
  const tgt = (over = {}) => ({ id: 'ash', name: 'ash', x: 1, y: 0, st: 'down', ...over })
  it("start / tick: the first tick emits at once, then nothing until 500 ms, then emits again", () => {
    const k = createKneel({ now: () => 0 })
    k.start('ash', 'ash', 1000, 3)
    expect(k.st).toEqual({ id: 'ash', name: 'ash', t0: 1000, ticks: 0, lastEmit: -Infinity, lastTick: 1000, press0: 3 })
    expect(k.tick(1000, tgt(), player)).toBe('emit'); expect(k.st.ticks).toBe(1)
    expect(k.tick(1200, tgt(), player)).toBe(null)
    expect(k.tick(1499, tgt(), player)).toBe(null)
    expect(k.tick(1500, tgt(), player)).toBe('emit'); expect(k.st.ticks).toBe(2)
    expect(k.st.lastEmit).toBe(1500); expect(k.st.lastTick).toBe(1500)
  })
  it('start records press0 (0 by default)', () => {
    const k = createKneel({ now: () => 7 })
    k.start('ash', 'ash')
    expect(k.st.press0).toBe(0); expect(k.st.t0).toBe(7)
  })
  it('dim reads 1, 0.919, ... 0.35 at 8 and stays 0.35 at 12', () => {
    const k = createKneel({ now: () => 0 })
    expect(k.dim()).toBe(1)
    k.start('ash', 'ash', 0)
    expect(k.dim()).toBe(1)
    k.tick(0, tgt(), player)
    expect(k.dim()).toBeCloseTo(0.919, 3)
    for (let i = 1; i < 8; i++) k.tick(i * 500, tgt(), player)
    expect(k.dim()).toBeCloseTo(0.35, 12)
    for (let i = 8; i < 12; i++) k.tick(i * 500, tgt(), player)
    expect(k.st.ticks).toBe(12); expect(k.dim()).toBeCloseTo(0.35, 12)
  })
  it("the target up, 6.1 cells away, or gone ends the kneel", () => {
    for (const t of [tgt({ st: 'ok' }), tgt({ st: 'kneel' }), tgt({ x: 6.1 }), null]) {
      const k = createKneel({ now: () => 0 })
      k.start('ash', 'ash', 0)
      expect(k.tick(10, t, player)).toBe('ended')
      expect(k.st).toBe(null)
      expect(k.tick(20, t, player)).toBe(null)
    }
    const k = createKneel({ now: () => 0 })
    k.start('ash', 'ash', 0)
    expect(k.tick(0, tgt({ x: 6 }), player)).toBe('emit')         // 6 cells is still within reach
  })
  it('wasKneelingOn: true while kneeling, true 1.9 s after the kneel ended on that id, false at 2.1 s and for another id', () => {
    const k = createKneel({ now: () => 0 })
    expect(k.wasKneelingOn('ash', 0)).toBe(false)
    k.start('ash', 'ash', 0)
    expect(k.wasKneelingOn('ash', 100)).toBe(true)
    expect(k.wasKneelingOn('moss', 100)).toBe(false)
    k.tick(5000, tgt({ st: 'ok' }), player)                       // the friend woke: here.st flipped before 'woke' arrives
    expect(k.st).toBe(null)
    expect(k.wasKneelingOn('ash', 6900)).toBe(true)
    expect(k.wasKneelingOn('ash', 7100)).toBe(false)
    expect(k.wasKneelingOn('moss', 6900)).toBe(false)
  })
  it('stop remembers the last kneel; stop with nothing on does not forget it', () => {
    let t = 0
    const k = createKneel({ now: () => t })
    k.start('ash', 'ash')
    t = 300; k.stop()
    expect(k.st).toBe(null)
    t = 500; k.stop()
    expect(k.wasKneelingOn('ash')).toBe(true)
    t = 2400; expect(k.wasKneelingOn('ash')).toBe(false)
  })
})

describe('the lines and numbers', () => {
  it('every line lowercase, no exclamation mark; the numbers', () => {
    expect(DOWN_LINE).toBe('everything goes dark. you are still here. somewhere, someone may notice.')
    expect(KNEEL_HINT).toBe('f · stay with them')
    expect(HANDS_LINE).toBe('your hands are on them.')
    expect(LIGHT_STAYS_LINE).toBe('your light stays on them.')
    expect(WOKEN_LINE).toBe('you are counted. you come back.')
    expect(KNEELER_LINE).toBe('you stayed. you counted them back.')
    for (const l of [DOWN_LINE, KNEEL_HINT, HANDS_LINE, LIGHT_STAYS_LINE, WOKEN_LINE, KNEELER_LINE]) {
      expect(l).toBe(l.toLowerCase()); expect(l).not.toContain('!')
    }
    expect(WAKE).toEqual({ hp: 60, sanity: 10, invuln: 2, regenDelay: 0 }); expect(Object.isFrozen(WAKE)).toBe(true)
    expect(KNEELER_SANITY).toBe(8)
    expect(DOWN_BEAT).toEqual({ intensity: 0.3, everyS: 2 }); expect(Object.isFrozen(DOWN_BEAT)).toBe(true)
  })
  it("DOWN_LINE is not the core's death line and never says 'you wake where you fell in.'", () => {
    expect(DOWN_LINE).not.toBe('everything goes dark.')
    for (const l of [DOWN_LINE, WOKEN_LINE, KNEELER_LINE]) expect(l).not.toContain('you wake where you fell in.')
  })
})

describe('legacy identity (the values the gated game.js lines read at rest)', () => {
  it("nobody down: st 'ok', lift 0, tick null, a stray kneel ignored", () => {
    const d = createDownState({ now: () => 5 })
    expect(d.st).toBe('ok'); expect(d.lift()).toBe(0); expect(d.tick()).toBe(null); expect(d.kneelTick('x')).toBe('ignored')
    expect(d.progress).toBe(0); expect(d.kneeler).toBe(null); expect(d.since).toBeNaN()
    expect(createDownState().st).toBe('ok')
  })
  it('nobody kneeling: st null, tick null', () => {
    const k = createKneel({ now: () => 5 })
    expect(k.st).toBe(null); expect(k.tick()).toBe(null); expect(k.dim()).toBe(1); expect(k.wasKneelingOn('x')).toBe(false)
    expect(createKneel().st).toBe(null)
  })
})
